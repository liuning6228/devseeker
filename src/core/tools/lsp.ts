/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * lsp 聚合工具（B-P2-5）
 *
 * DESIGN §M5.1 把 6 个 LSP 操作暴露为统一入口 `lsp(operation, ...)`，
 * 实现上仍分发到已有的 GoToDefinitionTool / FindReferencesTool / DocumentSymbolTool /
 * WorkspaceSymbolTool / GoToImplementationTool / CallHierarchyTool，
 * 避免代码重复 + 保留既有的 6 个独立工具兼容性。
 *
 * 为什么增加聚合工具？
 *   - LLM 面对「6 个 LSP 工具」很容易选错名字，特别是 goto_* 与 find_* 命名风格不统一；
 *   - 文档 DESIGN §M5.1 原本就按 1 个 `lsp` 工具描述，实际实现为保持向后兼容保留了 6 个；
 *   - 新的聚合入口让 Prompt 更精炼，未来可以把 6 个独立工具标为 deprecated。
 *
 * 参数形状：
 *   - `operation` (必填): 'goto_definition' | 'find_references' | 'document_symbol'
 *     | 'workspace_symbol' | 'goto_implementation' | 'call_hierarchy'
 *   - 其余参数按具体 operation 透传：
 *       file_path / line / character / include_declaration / query / limit / direction
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';
import { fail } from './goto_definition.js';
import { GoToDefinitionTool, type GoToDefinitionDeps } from './goto_definition.js';
import { FindReferencesTool, type FindReferencesDeps } from './find_references.js';
import { DocumentSymbolTool, type DocumentSymbolDeps } from './document_symbol.js';
import { WorkspaceSymbolTool, type WorkspaceSymbolDeps } from './workspace_symbol.js';
import { GoToImplementationTool, type GoToImplementationDeps } from './goto_implementation.js';
import { CallHierarchyTool, type CallHierarchyDeps } from './call_hierarchy.js';

export type LspOperation =
  | 'goto_definition'
  | 'find_references'
  | 'document_symbol'
  | 'workspace_symbol'
  | 'goto_implementation'
  | 'call_hierarchy';

export const LSP_OPERATIONS: readonly LspOperation[] = [
  'goto_definition',
  'find_references',
  'document_symbol',
  'workspace_symbol',
  'goto_implementation',
  'call_hierarchy',
] as const;

export interface LspToolArgs {
  operation: LspOperation;
  file_path?: string;
  line?: number;
  character?: number;
  include_declaration?: boolean;
  query?: string;
  limit?: number;
  direction?: 'incoming' | 'outgoing';
}

const parameters = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: LSP_OPERATIONS as unknown as string[],
      description:
        'LSP 操作：goto_definition / find_references / document_symbol / workspace_symbol / goto_implementation / call_hierarchy。',
    },
    file_path: {
      type: 'string',
      description: '文件路径。除 workspace_symbol 外都必填。',
    },
    line: { type: 'integer', minimum: 1, description: '1-based 行号（位置类操作必填）。' },
    character: { type: 'integer', minimum: 1, description: '1-based 列号（位置类操作必填）。' },
    include_declaration: {
      type: 'boolean',
      description: 'find_references 是否含声明，默认 true。',
    },
    query: { type: 'string', description: 'workspace_symbol 的符号名关键词。' },
    limit: {
      type: 'integer',
      minimum: 1,
      description: 'workspace_symbol 最多返回条数，默认 200。',
    },
    direction: {
      type: 'string',
      enum: ['incoming', 'outgoing'],
      description: 'call_hierarchy 方向：incoming=谁调了我 / outgoing=我调了谁。',
    },
  },
  required: ['operation'],
  additionalProperties: false,
} as const;

export interface LspToolDeps
  extends GoToDefinitionDeps,
    FindReferencesDeps,
    DocumentSymbolDeps,
    WorkspaceSymbolDeps,
    GoToImplementationDeps,
    CallHierarchyDeps {}

export class LspTool implements ITool<LspToolArgs, ToolResult> {
  readonly name = 'lsp';
  readonly description =
    'LSP 聚合入口：按 operation 分发到 goto_definition / find_references / document_symbol / workspace_symbol / goto_implementation / call_hierarchy。其余参数透传。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  private readonly gotoDef: GoToDefinitionTool;
  private readonly findRef: FindReferencesTool;
  private readonly docSym: DocumentSymbolTool;
  private readonly wsSym: WorkspaceSymbolTool;
  private readonly gotoImpl: GoToImplementationTool;
  private readonly callH: CallHierarchyTool;

  constructor(deps: LspToolDeps) {
    this.gotoDef = new GoToDefinitionTool(deps);
    this.findRef = new FindReferencesTool(deps);
    this.docSym = new DocumentSymbolTool(deps);
    this.wsSym = new WorkspaceSymbolTool(deps);
    this.gotoImpl = new GoToImplementationTool(deps);
    this.callH = new CallHierarchyTool(deps);
  }

  async execute(args: LspToolArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || !args.operation) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'operation 不能为空');
    }
    if (!LSP_OPERATIONS.includes(args.operation)) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `operation 非法：${args.operation}，必须是 ${LSP_OPERATIONS.join(' / ')} 之一`,
      );
    }

    switch (args.operation) {
      case 'goto_definition':
        return this.gotoDef.execute(
          {
            file_path: args.file_path ?? '',
            line: args.line ?? 0,
            character: args.character ?? 0,
          },
          ctx,
        );
      case 'find_references':
        return this.findRef.execute(
          {
            file_path: args.file_path ?? '',
            line: args.line ?? 0,
            character: args.character ?? 0,
            ...(args.include_declaration !== undefined
              ? { include_declaration: args.include_declaration }
              : {}),
          },
          ctx,
        );
      case 'document_symbol':
        return this.docSym.execute({ file_path: args.file_path ?? '' }, ctx);
      case 'workspace_symbol':
        return this.wsSym.execute(
          {
            query: args.query ?? '',
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          },
          ctx,
        );
      case 'goto_implementation':
        return this.gotoImpl.execute(
          {
            file_path: args.file_path ?? '',
            line: args.line ?? 0,
            character: args.character ?? 0,
          },
          ctx,
        );
      case 'call_hierarchy':
        return this.callH.execute(
          {
            file_path: args.file_path ?? '',
            line: args.line ?? 0,
            character: args.character ?? 0,
            direction: args.direction ?? 'incoming',
          },
          ctx,
        );
      default: {
        // Exhaustive check
        const _never: never = args.operation;
        return fail(ErrorCodes.TOOL_ARGS_INVALID, `未知 operation：${String(_never)}`);
      }
    }
  }
}
