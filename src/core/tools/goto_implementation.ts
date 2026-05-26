/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * goto_implementation 工具（W7e3 · 原 W5.3 漏账补齐）
 *
 * 职责：在指定文件/行/列处，调用 LSP 获取接口/抽象方法的实现位置。
 * 与 goto_definition 的区别：definition 跳到声明处，implementation 跳到具体实现。
 *
 * 参数同 goto_definition：file_path / line / character
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { LspBridge } from '../lsp/bridge.js';
import { validatePositionArgs, formatLocations, handleLspError } from './goto_definition.js';
import { ErrorCodes } from '../errors/index.js';

export interface GoToImplementationArgs {
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
      description: '光标所在的列号（1-based，含），指向接口/抽象符号。',
    },
  },
  required: ['file_path', 'line', 'character'],
  additionalProperties: false,
} as const;

export interface GoToImplementationDeps {
  getBridge(): LspBridge | undefined;
}

export class GoToImplementationTool implements ITool<GoToImplementationArgs, ToolResult> {
  readonly name = 'goto_implementation';
  readonly description =
    '跳转到实现：给定文件 + 1-based 行列坐标，返回该位置接口/抽象方法的具体实现列表。适合从接口定义找到所有实现类。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: GoToImplementationDeps) {}

  async execute(args: GoToImplementationArgs, ctx: ToolContext): Promise<ToolResult> {
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
      const impls = await bridge.goToImplementation(args.file_path, {
        line: args.line,
        character: args.character,
      });
      return formatLocations(impls, 'Implementations', args);
    } catch (e) {
      return handleLspError(e);
    }
  }
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
