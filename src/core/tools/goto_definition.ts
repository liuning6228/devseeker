/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * goto_definition 工具（W4 批次 1）
 *
 * 职责：在指定文件/行/列处，调用 LSP 获取符号定义位置
 *
 * 参数：
 * - file_path: 相对 / 绝对路径（必填）
 * - line: 1-based 行号（必填）
 * - character: 1-based 列号（必填）
 *
 * 输出：
 *   Definitions for <file_path>:<line>:<character>
 *   N results:
 *   1. <file>:<startLine>:<startChar>-<endLine>:<endChar>
 *   ...
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { LspBridge, LspLocation } from '../lsp/bridge.js';
import { ErrorCodes, AgentError } from '../errors/index.js';

export interface GoToDefinitionArgs {
  file_path: string;
  line: number;
  character: number;
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
      description: '光标所在的列号（1-based，含），指向目标符号的任意字符。',
    },
  },
  required: ['file_path', 'line', 'character'],
  additionalProperties: false,
} as const;

export interface GoToDefinitionDeps {
  /** 懒获取桥接器；未就绪时返回 undefined */
  getBridge(): LspBridge | undefined;
}

export class GoToDefinitionTool implements ITool<GoToDefinitionArgs, ToolResult> {
  readonly name = 'goto_definition';
  readonly description =
    '跳转到符号定义：给定文件 + 1-based 行列坐标，返回该位置符号的定义位置列表。适合理解陌生 API 真正的实现出处。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: GoToDefinitionDeps) {}

  async execute(args: GoToDefinitionArgs, ctx: ToolContext): Promise<ToolResult> {
    const err = validatePositionArgs(args);
    if (err) return fail(ErrorCodes.TOOL_ARGS_INVALID, err);

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
      const defs = await bridge.goToDefinition(args.file_path, {
        line: args.line,
        character: args.character,
      });
      return formatLocations(defs, 'Definitions', args);
    } catch (e) {
      return handleLspError(e);
    }
  }
}

// ─────────── helpers ───────────

export function validatePositionArgs(args: GoToDefinitionArgs): string | undefined {
  if (!args || typeof args.file_path !== 'string' || !args.file_path.trim()) {
    return 'file_path 不能为空';
  }
  if (!Number.isInteger(args.line) || args.line < 1) {
    return 'line 必须是 >= 1 的整数';
  }
  if (!Number.isInteger(args.character) || args.character < 1) {
    return 'character 必须是 >= 1 的整数';
  }
  return undefined;
}

export function formatLocations(
  locs: LspLocation[],
  kind: string,
  args: GoToDefinitionArgs,
): ToolResult {
  const head = `${kind} for ${args.file_path}:${args.line}:${args.character}`;
  if (!locs.length) {
    return ok(`${head}\n0 results\n`, { count: 0, locations: [] });
  }
  const lines: string[] = [head, `${locs.length} results:`];
  locs.forEach((l, i) => {
    lines.push(
      `${i + 1}. ${l.filePath}:${l.range.start.line}:${l.range.start.character}-${l.range.end.line}:${l.range.end.character}`,
    );
  });
  return ok(lines.join('\n') + '\n', {
    count: locs.length,
    locations: locs.map((l) => ({
      filePath: l.filePath,
      startLine: l.range.start.line,
      startChar: l.range.start.character,
      endLine: l.range.end.line,
      endChar: l.range.end.character,
    })),
  });
}

export function handleLspError(e: unknown): ToolResult {
  if (e instanceof AgentError) {
    return fail(e.code, e.message);
  }
  const err = e as { code?: string; message?: string };
  return fail(ErrorCodes.TOOL_EXEC_FAILED, `LSP 调用失败：${err.message ?? String(e)}`);
}

export function ok(content: string, display?: Record<string, unknown>): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}) };
}

export function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
