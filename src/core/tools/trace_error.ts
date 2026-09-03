/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * trace_error 工具（Debug 模式 P0 §2.1，P0-2 升级为一步取证复合工具）
 *
 * 高层工具封装“错误分析”完整流程，一次调用返回四节结构化报告：
 * 1. 失败点：失败文件 ±15 行上下文 + 错误信息/调用栈
 * 2. 调用链：对失败行上的符号做 goto_definition → call_hierarchy 反向追溯 +
 *    find_references 数据流追溯
 * 3. 文件诊断：附带该文件 error 级诊断（get_problems 桥接，未就绪时跳过）
 * 4. 测试线索：按命名约定 fs 探测相关测试文件（或测试文件反向提示被测源文件）
 *
 * 依赖：LspBridge + fs（直接读文件，不与 ReadFileTool 耦合）
 */

import { promises as fs } from 'node:fs';
import {
  resolve as resolvePath,
  isAbsolute,
  join as joinPath,
  basename,
  dirname,
  extname,
} from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { LspBridge, LspPosition } from '../lsp/bridge.js';
import type { ProblemsBridge } from '../problems/index.js';
import { ErrorCodes, AgentError } from '../errors/index.js';

const MAX_CONTEXT_LINES = 15;
/** P0-2 · 诊断附注上限（控制上下文预算） */
const MAX_PROBLEMS = 10;

export interface TraceErrorArgs {
  /** 错误信息（必填） */
  errorMessage: string;
  /** 调用栈（可选） */
  stackTrace?: string;
  /** 失败文件路径（必填，相对或绝对） */
  failingFile: string;
  /** 失败行号（必填，1-based） */
  failingLine: number;
  /** 追溯深度，默认 3 */
  depth?: number;
}

const parameters = {
  type: 'object',
  properties: {
    errorMessage: {
      type: 'string',
      description: '错误信息（必填）。',
    },
    stackTrace: {
      type: 'string',
      description: '调用栈（可选）。',
    },
    failingFile: {
      type: 'string',
      description: '失败文件路径（相对工作区或绝对路径）。',
    },
    failingLine: {
      type: 'integer',
      minimum: 1,
      description: '失败行号（1-based）。',
    },
    depth: {
      type: 'integer',
      minimum: 1,
      maximum: 5,
      description: '追溯深度（调用链层数），默认 3。',
    },
  },
  required: ['errorMessage', 'failingFile', 'failingLine'],
  additionalProperties: false,
} as const;

export interface TraceErrorDeps {
  /** 懒获取 LSP 桥接器；未就绪时返回 undefined */
  getBridge(): LspBridge | undefined;
  /** P0-2 · 可选：诊断桥接器；未传或取不到时诊断节降级为跳过而非失败 */
  getProblemsBridge?(): ProblemsBridge | undefined;
}

export class TraceErrorTool implements ITool<TraceErrorArgs, ToolResult> {
  readonly name = 'trace_error';
  readonly description =
    '高层错误分析工具：给定错误信息/文件/行号，一次调用返回四节报告——失败上下文、调用链追溯（goto_definition → call_hierarchy → find_references）、该文件 error 级诊断、相关测试文件线索。替代多次 LSP/诊断工具调用。仅在 Debug 模式下使用。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: TraceErrorDeps) {}

  async execute(args: TraceErrorArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args.errorMessage !== 'string' || !args.errorMessage.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'errorMessage 不能为空');
    }
    if (!args.failingFile || typeof args.failingFile !== 'string') {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'failingFile 不能为空');
    }
    if (!Number.isInteger(args.failingLine) || args.failingLine < 1) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'failingLine 必须是 >= 1 的整数');
    }

    const depth = args.depth ?? 3;
    if (depth < 1 || depth > 5) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'depth 必须在 1-5 之间');
    }

    const bridge = this.deps.getBridge();
    if (!bridge) {
      return fail(
        ErrorCodes.LSP_SERVER_NOT_RUNNING,
        'LSP 桥接器未就绪（可能未打开工作区或 VSCode API 不可用）',
      );
    }
    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    const reports: string[] = [];
    const filePath = args.failingFile;

    // ── Step 1: 读取失败文件上下文 ──
    reports.push('## Trace Report for ' + filePath + ':' + args.failingLine + '\n');
    reports.push('### 1. 失败点');
    reports.push(filePath + ':' + args.failingLine + ' — ' + args.errorMessage);
    if (args.stackTrace) {
      reports.push('\n**调用栈：**\n```\n' + args.stackTrace + '\n```');
    }

    const context = await readFileContext(filePath, args.failingLine, ctx);
    if (context) {
      reports.push('\n**失败上下文：**');
      reports.push('```');
      reports.push(context);
      reports.push('```');
    }

    // ── Step 2: 符号解析 + 调用链追溯 ──
    reports.push('\n### 2. 调用链（反向追溯）');

    try {
      // 对失败行上的所有符号做分析
      // 使用多个列位置尝试解析（行首、行中、行尾附近的符号）
      const positions = guessPositions(args.failingLine, context);
      let foundAny = false;

      for (const pos of positions) {
        if (ctx.signal.aborted) break;

        // 2a. goto_definition
        const defs = await bridge.goToDefinition(filePath, pos);
        if (defs.length === 0) continue;
        foundAny = true;

        reports.push(
          `\n符号 \`${formatPos(pos)}\` 定义于：`,
        );
        for (const d of defs) {
          reports.push(`- \`${d.filePath}:${d.range.start.line}:${d.range.start.character}\`${d.preview ? ' ' + d.preview : ''}`);
        }

        // 2b. call_hierarchy（incoming）—— 谁调用了这个符号
        if (defs.length > 0) {
          const firstDef = defs[0];
          await traceCallHierarchy(
            bridge,
            firstDef.filePath,
            { line: firstDef.range.start.line, character: firstDef.range.start.character },
            depth,
            0,
            reports,
            ctx,
          );
        }

        // 2c. 数据流追溯
        const refs = await bridge.findReferences(filePath, pos, false);
        if (refs.length > 0) {
          reports.push('\n**引用点：**');
          for (const r of refs.slice(0, 5)) {
            reports.push(`- \`${r.filePath}:${r.range.start.line}:${r.range.start.character}\``);
          }
          if (refs.length > 5) {
            reports.push(`- ... 还有 ${refs.length - 5} 处`);
          }
        }
      }

      if (!foundAny) {
        reports.push('\n在失败行未找到可追溯的符号。请确认文件路径和行号是否正确，或尝试 LSP 重新启动。');
      }
    } catch (e) {
      reports.push('\n**追溯过程出错：** ' + (e instanceof Error ? e.message : String(e)));
    }

    // ── Step 3: 文件诊断（P0-2 · 自动附带，无需 LLM 另调 get_problems）──
    reports.push('\n### 3. 文件诊断');
    const problemsBridge = this.deps.getProblemsBridge?.();
    if (!problemsBridge) {
      reports.push('（诊断桥接器未就绪，跳过）');
    } else {
      try {
        const diags = await problemsBridge.getDiagnostics({
          filePaths: [filePath],
          minSeverity: 'error',
        });
        if (diags.length === 0) {
          reports.push('该文件无 error 级诊断。');
        } else {
          for (const d of diags.slice(0, MAX_PROBLEMS)) {
            const src = [d.source, d.code !== undefined ? String(d.code) : undefined]
              .filter(Boolean)
              .join(' ');
            reports.push(
              `- [${d.severity}] ${d.filePath}:${d.line}:${d.character} — ${d.message.replace(/\s+/g, ' ').trim()}${src ? ` (${src})` : ''}`,
            );
          }
          if (diags.length > MAX_PROBLEMS) {
            reports.push(`- … 还有 ${diags.length - MAX_PROBLEMS} 条未列出`);
          }
        }
      } catch (e) {
        reports.push('（诊断读取失败：' + (e instanceof Error ? e.message : String(e)) + '）');
      }
    }

    // ── Step 4: 测试线索（P0-2 · fs 命名约定探测，轻量不 spawn 子进程）──
    reports.push('\n### 4. 测试线索');
    const related = await findRelatedTestFiles(filePath, ctx.workspaceRoot);
    if (related.files.length === 0) {
      reports.push('未发现相关测试文件（按命名约定探测）。');
    } else if (related.kind === 'source') {
      reports.push('当前文件是测试文件，推测被测源文件：');
      for (const f of related.files) reports.push(`- ${f}`);
    } else {
      reports.push('疑似相关测试文件：');
      for (const f of related.files) reports.push(`- ${f}`);
    }

    return ok(reports.join('\n') + '\n');
  }
}

// ─────────── helpers ───────────

/**
 * 读取失败行附近的代码上下文。
 * 返回格式化后的行文本（带行号前缀）；若文件不可读则返回 undefined。
 */
async function readFileContext(
  filePath: string,
  failingLine: number,
  ctx: ToolContext,
): Promise<string | undefined> {
  const ws = ctx.workspaceRoot;
  if (!ws) return undefined;

  try {
    const absPath = isAbsolute(filePath) ? resolvePath(filePath) : resolvePath(ws, filePath);
    const content = await fs.readFile(absPath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, failingLine - 1 - MAX_CONTEXT_LINES);
    const end = Math.min(lines.length, failingLine + MAX_CONTEXT_LINES);
    const out: string[] = [];
    for (let i = start; i < end; i++) {
      const prefix = i === failingLine - 1 ? '→' : ' ';
      out.push(prefix + ' ' + (i + 1) + '\t' + lines[i]);
    }
    return out.join('\n');
  } catch {
    return undefined;
  }
}

/** 在失败行上猜测可能的关键符号列位置 */
function guessPositions(line: number, context: string | undefined): LspPosition[] {
  // 一定尝试行首（常见于函数调用起始位置）
  const positions: LspPosition[] = [
    { line, character: 1 },
  ];

  if (context) {
    // 从上下文里找失败行内容
    const lines = context.split('\n');
    const failingLineContent = lines.find((l) => l.startsWith('→'));
    if (failingLineContent) {
      // 找到第一个非空格的标识符起始位置
      const trimmed = failingLineContent.replace(/^→\s*\d+\s*/, '');
      const prefixLen = failingLineContent.length - trimmed.length;
      const firstIdent = trimmed.search(/[a-zA-Z_$]/);
      if (firstIdent >= 0) {
        // character 为 1-based 列号：去掉前缀后偏移
        positions.push({ line, character: prefixLen + firstIdent + 1 });
      }
      // 如果行中有方法调用 .xxx(，在 . 后面也试
      const dotCallMatch = trimmed.match(/\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/);
      if (dotCallMatch) {
        const dotIdx = trimmed.indexOf(dotCallMatch[0]);
        positions.push({ line, character: prefixLen + dotIdx + 1 });
      }
    }
  }

  return positions;
}

/** 递归追溯调用链 */
async function traceCallHierarchy(
  bridge: LspBridge,
  filePath: string,
  pos: LspPosition,
  maxDepth: number,
  currentDepth: number,
  reports: string[],
  ctx: ToolContext,
): Promise<void> {
  if (currentDepth >= maxDepth) return;
  if (ctx.signal.aborted) return;

  try {
    const callers = await bridge.callHierarchy(filePath, pos, 'incoming');
    if (callers.length === 0) return;

    const depthLabel = maxDepth - currentDepth;
    reports.push(`\nL${depthLabel} callers of \`${filePath}:${pos.line}:${pos.character}\`:`);

    for (const caller of callers) {
      const loc = caller.location;
      const locStr = `\`${loc.filePath}:${loc.range.start.line}:${loc.range.start.character}\``;
      reports.push(`- ${locStr} \`${caller.name}\` (${caller.kind})`);

      // 递归追溯该调用者的 caller
      if (currentDepth + 1 < maxDepth) {
        await traceCallHierarchy(
          bridge,
          loc.filePath,
          { line: loc.range.start.line, character: loc.range.start.character },
          maxDepth,
          currentDepth + 1,
          reports,
          ctx,
        );
      }
    }
  } catch {
    // 单层失败不中止整体报告
    reports.push(`\n（追溯 \`${filePath}:${pos.line}:${pos.character}\` 的调用者失败）`);
  }
}

function formatPos(pos: LspPosition): string {
  return `${pos.line}:${pos.character}`;
}

/** 判断文件名是否为测试命名约定（*.test.* / *.spec.* / test_*.py） */
function isTestFileName(base: string): boolean {
  return (
    /\.test\.[a-zA-Z0-9]+$/.test(base) ||
    /\.spec\.[a-zA-Z0-9]+$/.test(base) ||
    /^test_[a-zA-Z0-9_-]+\.py$/.test(base)
  );
}

/** 从测试文件名剥离测试标记（foo.test.ts → foo.ts；test_foo.py → foo.py） */
function stripTestMarker(base: string): string {
  return base
    .replace(/\.test\./i, '.')
    .replace(/\.spec\./i, '.')
    .replace(/^test_/i, '');
}

/**
 * P0-2 · 探测失败文件的相关测试文件（或测试文件反向提示被测源文件）。
 * 仅返回磁盘上真实存在的文件：fs.access 探测，不 spawn 子进程。
 */
async function findRelatedTestFiles(
  filePath: string,
  workspaceRoot: string | undefined,
): Promise<{ kind: 'tests' | 'source'; files: string[] }> {
  if (!workspaceRoot) return { kind: 'tests', files: [] };
  const abs = isAbsolute(filePath) ? resolvePath(filePath) : resolvePath(workspaceRoot, filePath);
  const dir = dirname(abs);
  const base = basename(abs);
  const ext = extname(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;

  const candidates: string[] = [];
  if (isTestFileName(base)) {
    // 失败文件是测试文件 → 反向提示被测源文件
    candidates.push(joinPath(dir, stripTestMarker(base)));
  } else {
    candidates.push(joinPath(dir, stem + '.test' + ext));
    candidates.push(joinPath(dir, stem + '.spec' + ext));
    candidates.push(joinPath(dir, '__tests__', stem + '.test' + ext));
    candidates.push(joinPath(dir, '__tests__', stem + '.spec' + ext));
    if (ext === '.py') {
      candidates.push(joinPath(dir, 'test_' + stem + '.py'));
    }
  }

  const found: string[] = [];
  for (const c of [...new Set(candidates)]) {
    try {
      await fs.access(c);
      found.push(c);
    } catch {
      // 文件不存在，跳过
    }
  }
  return { kind: isTestFileName(base) ? 'source' : 'tests', files: found };
}

function ok(content: string, display?: Record<string, unknown>): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}) };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
