/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * call_hierarchy 工具（W7e3 · 原 W5.3 漏账补齐）
 *
 * 职责：查询调用链 —— 给定文件/行/列处的符号，
 * 返回 incoming（谁调了我）或 outgoing（我调了谁）的调用者/被调用者列表。
 *
 * 参数：
 * - file_path / line / character：指向目标符号
 * - direction：'incoming' | 'outgoing'
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { LspBridge, CallHierarchyEntry, LspPosition } from '../lsp/bridge.js';
import { validatePositionArgs, handleLspError } from './goto_definition.js';
import { ErrorCodes } from '../errors/index.js';

export interface CallHierarchyArgs {
  file_path: string;
  line: number;
  character: number;
  direction: 'incoming' | 'outgoing';
}

const parameters = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: '源文件路径（相对工作区或绝对路径）。',
    },
    line: {
      type: 'integer',
      minimum: 1,
      description: '光标所在的行号（1-based，含）。',
    },
    character: {
      type: 'integer',
      minimum: 1,
      description: '光标所在的列号（1-based，含），指向目标函数/方法符号。',
    },
    direction: {
      type: 'string',
      enum: ['incoming', 'outgoing'],
      description:
        'incoming = 谁调用了这个函数（调用者）；outgoing = 这个函数调用了谁（被调用者）。',
    },
  },
  required: ['file_path', 'line', 'character', 'direction'],
  additionalProperties: false,
} as const;

export interface CallHierarchyDeps {
  getBridge(): LspBridge | undefined;
}

export class CallHierarchyTool implements ITool<CallHierarchyArgs, ToolResult> {
  readonly name = 'call_hierarchy';
  readonly description =
    '查询调用链：给定文件+行列+方向，返回调用者（incoming）或被调用者（outgoing）列表。适合理解函数间依赖关系、追踪调用路径。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: CallHierarchyDeps) {}

  async execute(args: CallHierarchyArgs, ctx: ToolContext): Promise<ToolResult> {
    const posErr = validatePositionArgs(args);
    if (posErr) return fail(ErrorCodes.TOOL_ARGS_INVALID, posErr);
    if (!args.direction || (args.direction !== 'incoming' && args.direction !== 'outgoing')) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'direction 必须是 "incoming" 或 "outgoing"');
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

    try {
      const pos: LspPosition = { line: args.line, character: args.character };
      const entries = await bridge.callHierarchy(args.file_path, pos, args.direction);
      return formatHierarchy(entries, args);
    } catch (e) {
      return handleLspError(e);
    }
  }
}

// ─────────── helpers ───────────

function formatHierarchy(entries: CallHierarchyEntry[], args: CallHierarchyArgs): ToolResult {
  const label = args.direction === 'incoming' ? 'Callers (incoming)' : 'Callees (outgoing)';
  const head = `${label} for ${args.file_path}:${args.line}:${args.character}`;

  if (entries.length === 0) {
    return ok(`${head}\n0 results\n`, { count: 0, entries: [] });
  }

  const lines: string[] = [head, `${entries.length} results:`];
  entries.forEach((e, i) => {
    const loc = `${e.location.filePath}:${e.location.range.start.line}:${e.location.range.start.character}`;
    const from = e.fromRanges && e.fromRanges.length > 0
      ? ` (call sites: ${e.fromRanges.map((r) => `L${r.start.line}`).join(', ')})`
      : '';
    lines.push(`${i + 1}. [${e.kind}] ${e.name} — ${loc}${from}`);
  });

  return ok(lines.join('\n') + '\n', {
    count: entries.length,
    entries: entries.map((e) => ({
      name: e.name,
      kind: e.kind,
      filePath: e.location.filePath,
      startLine: e.location.range.start.line,
      startChar: e.location.range.start.character,
    })),
  });
}

function ok(content: string, display?: Record<string, unknown>): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}) };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
