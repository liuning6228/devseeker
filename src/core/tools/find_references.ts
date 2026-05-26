/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * find_references 工具（W4 批次 1）
 *
 * 给定符号位置，返回所有引用点位置列表（包括声明处）。
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { LspBridge } from '../lsp/bridge.js';
import { ErrorCodes } from '../errors/index.js';
import {
  validatePositionArgs,
  formatLocations,
  handleLspError,
  fail,
  type GoToDefinitionArgs,
} from './goto_definition.js';

export interface FindReferencesArgs extends GoToDefinitionArgs {
  include_declaration?: boolean;
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
      description: '光标所在的列号（1-based，含）。',
    },
    include_declaration: {
      type: 'boolean',
      description: '是否包含声明处，默认 true。某些语言服务器忽略该参数。',
    },
  },
  required: ['file_path', 'line', 'character'],
  additionalProperties: false,
} as const;

export interface FindReferencesDeps {
  getBridge(): LspBridge | undefined;
}

export class FindReferencesTool implements ITool<FindReferencesArgs, ToolResult> {
  readonly name = 'find_references';
  readonly description =
    '查找符号的所有引用点：给定文件 + 1-based 行列坐标，返回该符号在工作区内的所有引用位置（含声明）。适合评估改名/删除的影响面。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: FindReferencesDeps) {}

  async execute(args: FindReferencesArgs, ctx: ToolContext): Promise<ToolResult> {
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
      const refs = await bridge.findReferences(
        args.file_path,
        { line: args.line, character: args.character },
        args.include_declaration ?? true,
      );
      return formatLocations(refs, 'References', args);
    } catch (e) {
      return handleLspError(e);
    }
  }
}
