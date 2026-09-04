/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * lsp_type_definition 工具（检索差距弥补计划 T2）
 *
 * 给定文件 + 1-based 行列坐标，返回该符号的类型定义位置（接口/类型别名/类）。
 * 主要服务 `lsp` 聚合入口；输出格式与 find_references 对齐（formatLocations）。
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

export type TypeDefinitionArgs = GoToDefinitionArgs;

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

export interface TypeDefinitionDeps {
  getBridge(): LspBridge | undefined;
}

export class TypeDefinitionTool implements ITool<TypeDefinitionArgs, ToolResult> {
  readonly name = 'lsp_type_definition';
  readonly description =
    '类型定义：给定文件 + 1-based 行列坐标，返回该位置符号的类型声明位置（interface/type/class 定义处）。适合从使用点直接跳到类型的真正契约。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: TypeDefinitionDeps) {}

  async execute(args: TypeDefinitionArgs, ctx: ToolContext): Promise<ToolResult> {
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
      const defs = await bridge.typeDefinition(args.file_path, {
        line: args.line,
        character: args.character,
      });
      return formatLocations(defs, 'Type definitions', args);
    } catch (e) {
      return handleLspError(e);
    }
  }
}