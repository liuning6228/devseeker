/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * document_symbol 工具（W4 批次 1）
 *
 * 列出指定文件内的所有符号（类 / 方法 / 函数 / 变量 等，带层级 containerName）。
 * 适合快速了解文件结构 / 定位大文件中的目标符号。
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { LspBridge, LspSymbol } from '../lsp/bridge.js';
import { ErrorCodes } from '../errors/index.js';
import { handleLspError, fail, ok } from './goto_definition.js';

export interface DocumentSymbolArgs {
  file_path: string;
}

const parameters = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: '目标文件路径（相对工作区或绝对路径）。',
    },
  },
  required: ['file_path'],
  additionalProperties: false,
} as const;

export interface DocumentSymbolDeps {
  getBridge(): LspBridge | undefined;
}

export class DocumentSymbolTool implements ITool<DocumentSymbolArgs, ToolResult> {
  readonly name = 'document_symbol';
  readonly description =
    '列出指定文件的符号大纲（类/方法/函数/常量等，带容器层级）。适合快速了解陌生文件的结构。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: DocumentSymbolDeps) {}

  async execute(args: DocumentSymbolArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args.file_path !== 'string' || !args.file_path.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'file_path 不能为空');
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
      const syms = await bridge.documentSymbols(args.file_path);
      return formatSymbols(syms, `Symbols in ${args.file_path}`);
    } catch (e) {
      return handleLspError(e);
    }
  }
}

export function formatSymbols(syms: LspSymbol[], header: string): ToolResult {
  if (!syms.length) {
    return ok(`${header}\n0 symbols\n`, { count: 0, symbols: [] });
  }
  const lines: string[] = [header, `${syms.length} symbols:`];
  syms.forEach((s, i) => {
    const container = s.containerName ? `${s.containerName}.` : '';
    lines.push(
      `${i + 1}. [${s.kind}] ${container}${s.name} @ ${s.location.filePath}:${s.location.range.start.line}:${s.location.range.start.character}`,
    );
  });
  return ok(lines.join('\n') + '\n', {
    count: syms.length,
    symbols: syms.map((s) => ({
      name: s.name,
      kind: s.kind,
      containerName: s.containerName,
      filePath: s.location.filePath,
      line: s.location.range.start.line,
      character: s.location.range.start.character,
    })),
  });
}
