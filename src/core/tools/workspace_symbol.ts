/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * workspace_symbol 工具（W4 批次 1）
 *
 * 在整个工作区内按名称搜索符号（类、函数、方法等）。
 * 相当于 VSCode 的 "Go to Symbol in Workspace"（Ctrl+T）。
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { LspBridge } from '../lsp/bridge.js';
import { ErrorCodes } from '../errors/index.js';
import { handleLspError, fail } from './goto_definition.js';
import { formatSymbols } from './document_symbol.js';

export interface WorkspaceSymbolArgs {
  query: string;
  limit?: number;
}

const parameters = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '符号名查询字符串（支持模糊匹配）。示例："TaskLoop" / "handleError"。',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      description: '最大返回数量，默认 50。',
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

export interface WorkspaceSymbolDeps {
  getBridge(): LspBridge | undefined;
}

export class WorkspaceSymbolTool implements ITool<WorkspaceSymbolArgs, ToolResult> {
  readonly name = 'workspace_symbol';
  readonly description =
    '在整个工作区按名称搜索符号（类/函数/方法等）。适合不知道文件在哪但知道符号名的情况。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: WorkspaceSymbolDeps) {}

  async execute(args: WorkspaceSymbolArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args.query !== 'string' || !args.query.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'query 不能为空');
    }
    const limit = Math.min(200, Math.max(1, args.limit ?? 50));

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
      const syms = await bridge.workspaceSymbols(args.query, limit);
      return formatSymbols(syms, `Workspace symbols matching "${args.query}"`);
    } catch (e) {
      return handleLspError(e);
    }
  }
}
