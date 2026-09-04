/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * grep_code 工具（D5 修复）
 *
 * 职责：在 workspace 中执行文本 grep 搜索，返回匹配的文件路径、行号、内容片段。
 * 对应 `search_codebase` 的语义搜索补充——grep_code 是精确文本匹配，适合：
 * - 查找接口签名实现/调用点（refactor 场景）
 * - 查找字符串字面量、函数名、错误信息
 * - 跨文件验证重构前后的符号命中数
 *
 * 实现：通过 child_process.spawn 执行系统 grep（POSIX）/ findstr（Windows）。
 * 不需要 CodebaseIndex 或 LSP bridge，开箱即用。
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';
import {
  probeRgAvailable,
  resolveEngine,
  runRg,
  type RgLine,
} from './rg-search.js';

export interface GrepCodeArgs {
  /** 要搜索的文本模式（精确字符串，非正则） */
  query: string;
  /** 可选：限定搜索目录，默认为 workspaceRoot */
  path?: string;
  /** 可选：最大返回匹配行数，默认 50，最大 200 */
  max_lines?: number;
  /** 可选：每个匹配的上下文行数（上下各 N 行），默认 0，最大 5；只对 rg/grep 引擎生效 */
  context_lines?: number;
}

const parameters = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '要搜索的精确文本模式。示例："async *createMessage" / "ToolExecutor"。注意：不是正则，是固定字符串匹配。',
    },
    path: {
      type: 'string',
      description: '限定搜索的子目录路径（相对 workspaceRoot）。缺省搜索整个 workspace。',
    },
    max_lines: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      description: '最大返回匹配行数，默认 50，最大 200。超出的部分会被截断并标注。',
    },
    context_lines: {
      type: 'integer',
      minimum: 0,
      maximum: 5,
      description: '每个匹配附带上下文行数（匹配行上下各 N 行，用行号标注），默认 0。适合需要了解函数体/调用点上下文时开启。',
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

const safetyLevel = 'read_only' as const satisfies ToolSafetyLevel;

export class GrepCodeTool implements ITool<GrepCodeArgs> {
  readonly name = 'grep_code';
  readonly description =
    '在代码库中精确搜索字符串文本（grep），返回文件路径、行号和匹配行内容。适合查找接口签名、函数名、错误信息等。';
  readonly parameters = parameters;
  readonly safetyLevel = safetyLevel;

  async execute(args: GrepCodeArgs, ctx: ToolContext): Promise<ToolResult> {
    const query = args.query?.trim();
    if (!query) {
      return {
        ok: false,
        content: '参数错误：`query` 不能为空。',
        errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      };
    }

    const rootDir = args.path
      ? ctx.workspaceRoot
        ? joinPath(ctx.workspaceRoot, args.path)
        : args.path
      : ctx.workspaceRoot || '.';

    if (ctx.signal.aborted) {
      return { ok: false, content: '任务已取消', errorCode: ErrorCodes.TASK_LOOP_ABORTED };
    }

    const maxLines = args.max_lines ?? 50;
    const contextLines = args.context_lines ?? 0;
    const isWin = platform() === 'win32';

    try {
      // 检索差距弥补计划 T1 · 引擎自动选择：rg 可用 → rg（含原生 -A/-B 上下文），
      // 否则回退既有 grep/findstr（零回归）；findstr 不支持上下文参数（忽略 contextLines）
      const engine = resolveEngine(probeRgAvailable(), isWin);
      const out =
        engine === 'rg'
          ? await runRgAsRows(rootDir, query, maxLines, ctx.signal, contextLines)
          : await runLegacyAsRows(rootDir, query, maxLines, isWin, ctx.signal, contextLines);

      if (ctx.signal.aborted) {
        return { ok: false, content: '任务已取消', errorCode: ErrorCodes.TASK_LOOP_ABORTED };
      }

      if (out.code !== 0 && out.code !== 1) {
        return {
          ok: false,
          content: `grep 执行失败（exit code=${out.code}）：${out.stderr || 'unknown error'}`,
          errorCode: ErrorCodes.TOOL_EXEC_FAILED,
        };
      }

      if (out.count === 0) {
        return { ok: true, content: `grep "${query}" 未找到匹配项。`, display: { engine, count: 0 } };
      }

      const output = [`grep "${query}" 共找到 ${out.count} 处匹配：`, '', ...out.rows].join('\n');
      return { ok: true, content: output, display: { engine, count: out.count } };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        content: `grep 搜索异常：${msg}`,
        errorCode: ErrorCodes.TOOL_EXEC_FAILED,
      };
    }
  }
}

// ─────────── 引擎行组装 ───────────

interface GrepOut {
  /** 展示行（match + context 全量） */
  rows: string[];
  /** 命中条数（kind=match / legacy 的匹配行数） */
  count: number;
  stderr: string;
  code: number;
}

/** rg 分支：--json 解析为行序列，统一 `path:line:text` 格式（上下文行同格式，行号自明） */
async function runRgAsRows(
  cwd: string,
  query: string,
  maxLines: number,
  signal: AbortSignal,
  contextLines: number,
): Promise<GrepOut> {
  const res = await runRg(cwd, query, maxLines, signal, contextLines);
  const rows = res.lines.map((l: RgLine) => `${l.path}:${l.line}:${l.text}`);
  // 64KB 截断时补一条可见标注（code 已归一为 0，部分结果可展示）
  if (res.truncated) rows.push('... (输出截断，超过 64KB)');
  return { rows, count: res.matchCount, stderr: res.stderr, code: res.code };
}

/** legacy 分支：既有 grep/findstr；POSIX grep 在 context>0 时追加 -A/-B */
async function runLegacyAsRows(
  cwd: string,
  query: string,
  maxLines: number,
  isWin: boolean,
  signal: AbortSignal,
  contextLines: number,
): Promise<GrepOut> {
  const res = await runGrep(cwd, query, maxLines, isWin, signal, contextLines);
  const lines = res.stdout.split('\n').filter((l) => l.trim().length > 0);
  return { rows: lines, count: lines.length, stderr: res.stderr, code: res.code };
}

function joinPath(a: string, b: string): string {
  // 避免在已有 / 的路径上重复拼接
  const sep = platform() === 'win32' ? '\\' : '/';
  const aEnd = a.endsWith(sep) ? a.slice(0, -1) : a;
  const bStart = b.startsWith(sep) ? b.slice(1) : b;
  return `${aEnd}${sep}${bStart}`;
}

interface GrepResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runGrep(
  cwd: string,
  query: string,
  maxLines: number,
  isWin: boolean,
  signal: AbortSignal,
  contextLines = 0,
): Promise<GrepResult> {
  return new Promise((resolve) => {
    // 转义特殊字符：--fixed-strings 模式也需要 shell-safe 的 query
    // 在 -F 模式下仅需避开 shell 元字符
    const escapedQuery = isWin ? query.replace(/"/g, '\\"') : query.replace(/"/g, '\\"');

    // 包含 node_modules/.git/dist 的排除规则
    const excludeDirs = isWin
      ? '/d /s'
      : `--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=out --exclude-dir=.devseeker`;

    // 搜索源代码文件（常见扩展名 + 无扩展名）。注意：spawn 数组模式不经 shell，
    // 不能写 --include='*.ts'（引号是 shell 语法，残留会给 grep 造成字面匹配）
    const includeExts = isWin ? '' : `--include=*.ts --include=*.tsx --include=*.js --include=*.jsx --include=*.json --include=*.md --include=*.css --include=*.html --include=*.yaml --include=*.yml`;

    let child;
    if (isWin) {
      // Windows: findstr /s /n 固定字符串（不支持上下文参数，contextLines 忽略）
      child = spawn('findstr', ['/s', '/n', '/c:' + escapedQuery, '*'], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: true,
      });
    } else {
      // POSIX: grep -rn -F；`-e query` 显式传 pattern（既有缺陷：query 从未
      // 进入参数数组，grep 会把 '.' 当 pattern 并从 stdin 读取 → 恒无匹配）；
      // context>0 时追加 -A/-B（对齐 rg 分支语义）
      const ctxArgs = contextLines > 0 ? ['-A', String(contextLines), '-B', String(contextLines)] : [];
      const grepArgs = [
        '-rn',           // 递归 + 行号
        '-F',            // 固定字符串
        '-e', query,     // 显式 pattern（-e 同时保护以 '-' 开头的 query）
        '-m', String(maxLines), // 每文件最大匹配数
        ...ctxArgs,
        ...excludeDirs.split(' '),
        ...includeExts.split(' '),
        '.',
      ];
      child = spawn('grep', grepArgs, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    const timeout = setTimeout(() => {
      child.kill();
    }, 30_000);

    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });

    let stdout = '';
    let stderr = '';
    let truncated = false;

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      // 截断是预期的安全行为：code 归 0 返回部分结果，不误报执行失败
      if (stdout.length > 65536) {
        stdout = stdout.slice(0, 65536) + '\n... (输出截断，超过 64KB)';
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, code: truncated ? 0 : (code ?? -1) });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr: err.message, code: -1 });
    });
  });
}
