/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * lsp_hover 工具（检索差距弥补计划 T2）
 *
 * 给定文件 + 1-based 行列坐标，返回该位置的悬停提示（类型/签名/文档）。
 * 主要服务 `lsp` 聚合入口；与 goto_definition 等 6 工具同构（ITool + getBridge DI）。
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { LspBridge, LspHover } from '../lsp/bridge.js';
import { ErrorCodes } from '../errors/index.js';
import {
  validatePositionArgs,
  handleLspError,
  fail,
  type GoToDefinitionArgs,
} from './goto_definition.js';

export type HoverArgs = GoToDefinitionArgs;

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
      description: '光标所在的列号（1-based，含）。',
    },
  },
  required: ['file_path', 'line', 'character'],
  additionalProperties: false,
} as const;

export interface HoverDeps {
  getBridge(): LspBridge | undefined;
}

export class HoverTool implements ITool<HoverArgs, ToolResult> {
  readonly name = 'lsp_hover';
  readonly description =
    '悬停提示：给定文件 + 1-based 行列坐标，返回该位置的类型/签名/文档说明（最多 3 段）。适合快速理解陌生 API 的参数与返回值，无需跳转。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: HoverDeps) {}

  async execute(args: HoverArgs, ctx: ToolContext): Promise<ToolResult> {
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
      const hovers = await bridge.hover(args.file_path, {
        line: args.line,
        character: args.character,
      });
      return formatHover(hovers, args);
    } catch (e) {
      return handleLspError(e);
    }
  }
}

// ─────────── helpers ───────────

function formatHover(hovers: LspHover[], args: HoverArgs): ToolResult {
  const head = `Hover for ${args.file_path}:${args.line}:${args.character}`;
  if (hovers.length === 0) {
    return ok(`${head}\n0 results\n`, { count: 0, sections: [] });
  }
  const lines: string[] = [head, `${hovers.length} sections:`];
  hovers.forEach((h, i) => {
    lines.push(`--- [${i + 1}]${h.language ? ` (${h.language})` : ''}`);
    if (h.language) {
      lines.push(`\`\`\`${h.language}`);
      lines.push(h.value);
      lines.push('```');
    } else {
      lines.push(h.value);
    }
  });
  return ok(lines.join('\n') + '\n', {
    count: hovers.length,
    sections: hovers.map((h) => ({ language: h.language, value: h.value })),
  });
}

function ok(content: string, display?: Record<string, unknown>): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}) };
}