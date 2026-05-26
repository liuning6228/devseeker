/**
 * Copyright (c) 2026 DualMind Contributors
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
import { collectEnvironment } from '../prompts/environment-probe.js';

export interface GrepCodeArgs {
  /** 要搜索的文本模式（精确字符串，非正则） */
  query: string;
  /** 可选：限定搜索目录，默认为 workspaceRoot */
  path?: string;
  /** 可选：最大返回匹配行数，默认 50，最大 200 */
  max_lines?: number;
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
    const isWin = platform() === 'win32';

    try {
      const result = await runGrep(rootDir, query, maxLines, isWin, ctx.signal);

      if (ctx.signal.aborted) {
        return { ok: false, content: '任务已取消', errorCode: ErrorCodes.TASK_LOOP_ABORTED };
      }

      if (result.code !== 0 && result.code !== 1) {
        return {
          ok: false,
          content: `grep 执行失败（exit code=${result.code}）：${result.stderr || 'unknown error'}`,
          errorCode: ErrorCodes.TOOL_EXEC_FAILED,
        };
      }

      const lines = result.stdout
        .split('\n')
        .filter((l) => l.trim().length > 0);

      if (lines.length === 0) {
        return { ok: true, content: `grep "${query}" 未找到匹配项。` };
      }

      const output = [`grep "${query}" 共找到 ${lines.length} 处匹配：`, '', ...lines].join('\n');
      return { ok: true, content: output };
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
): Promise<GrepResult> {
  return new Promise((resolve) => {
    // 转义特殊字符：--fixed-strings 模式也需要 shell-safe 的 query
    // 在 -F 模式下仅需避开 shell 元字符
    const escapedQuery = isWin ? query.replace(/"/g, '\\"') : query.replace(/"/g, '\\"');

    // 包含 node_modules/.git/dist 的排除规则
    const excludeDirs = isWin
      ? '/d /s'
      : `--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=out --exclude-dir=.dualmind`;

    // 搜索源代码文件（常见扩展名 + 无扩展名）
    const includeExts = isWin ? '' : `--include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.json' --include='*.md' --include='*.css' --include='*.html' --include='*.yaml' --include='*.yml'`;

    let child;
    if (isWin) {
      // Windows: findstr /s /n 固定字符串
      child = spawn('findstr', ['/s', '/n', '/c:' + escapedQuery, '*'], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: true,
      });
    } else {
      // POSIX: grep -rn -F --fixed-strings
      const grepArgs = [
        '-rn',           // 递归 + 行号
        '-F',            // 固定字符串
        '-m', String(maxLines), // 每文件最大匹配数
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

    signal.addEventListener('abort', () => {
      child.kill();
    }, { once: true });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      // 截断
      if (stdout.length > 65536) {
        stdout = stdout.slice(0, 65536) + '\n... (输出截断，超过 64KB)';
        child.kill();
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr: err.message, code: -1 });
    });
  });
}
