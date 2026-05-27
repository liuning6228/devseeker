/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-P2-5 · 聚合 lsp 工具单测（分发到 6 个内部实现）
 */
import { describe, it, expect } from 'vitest';
import { LspTool, LSP_OPERATIONS } from '../../src/core/tools/lsp.js';
import type {
  LspBridge,
  LspLocation,
  LspPosition,
  LspSymbol,
  CallHierarchyEntry,
} from '../../src/core/lsp/bridge.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

function range(sl: number, sc: number, el: number, ec: number) {
  return {
    start: { line: sl, character: sc },
    end: { line: el, character: ec },
  };
}

class FakeBridge implements LspBridge {
  defs: LspLocation[] = [];
  refs: LspLocation[] = [];
  docSyms: LspSymbol[] = [];
  wsSyms: LspSymbol[] = [];
  impls: LspLocation[] = [];
  callHier: CallHierarchyEntry[] = [];
  calls: Array<{ kind: string; args: unknown[] }> = [];

  async goToDefinition(filePath: string, pos: LspPosition): Promise<LspLocation[]> {
    this.calls.push({ kind: 'def', args: [filePath, pos] });
    return this.defs;
  }
  async findReferences(
    filePath: string,
    pos: LspPosition,
    incl?: boolean,
  ): Promise<LspLocation[]> {
    this.calls.push({ kind: 'ref', args: [filePath, pos, incl] });
    return this.refs;
  }
  async documentSymbols(filePath: string): Promise<LspSymbol[]> {
    this.calls.push({ kind: 'docSym', args: [filePath] });
    return this.docSyms;
  }
  async workspaceSymbols(query: string, limit?: number): Promise<LspSymbol[]> {
    this.calls.push({ kind: 'wsSym', args: [query, limit] });
    return this.wsSyms;
  }
  async goToImplementation(filePath: string, pos: LspPosition): Promise<LspLocation[]> {
    this.calls.push({ kind: 'impl', args: [filePath, pos] });
    return this.impls;
  }
  async callHierarchy(
    filePath: string,
    pos: LspPosition,
    direction: 'incoming' | 'outgoing',
  ): Promise<CallHierarchyEntry[]> {
    this.calls.push({ kind: 'callHier', args: [filePath, pos, direction] });
    return this.callHier;
  }
}

function ctx() {
  return {
    workspaceRoot: '/ws',
    signal: new AbortController().signal,
    taskId: 't1',
    toolCallId: 'tc1',
  };
}

describe('LspTool · 聚合分发', () => {
  it('operation 枚举齐备（6 种）', () => {
    expect(LSP_OPERATIONS).toHaveLength(6);
    expect(new Set(LSP_OPERATIONS).size).toBe(6);
  });

  it('name/description/parameters 签名完整', () => {
    const b = new FakeBridge();
    const tool = new LspTool({ getBridge: () => b });
    expect(tool.name).toBe('lsp');
    expect(tool.safetyLevel).toBe('read_only');
    const params = tool.parameters as { required?: string[]; properties?: Record<string, unknown> };
    expect(params.required).toEqual(['operation']);
    expect(params.properties).toHaveProperty('operation');
    expect(params.properties).toHaveProperty('file_path');
    expect(params.properties).toHaveProperty('direction');
  });

  it('空 operation → TOOL_ARGS_INVALID', async () => {
    const tool = new LspTool({ getBridge: () => new FakeBridge() });
    const r = await tool.execute({} as never, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('非法 operation → TOOL_ARGS_INVALID', async () => {
    const tool = new LspTool({ getBridge: () => new FakeBridge() });
    const r = await tool.execute({ operation: 'unknown_op' as never }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('goto_definition 分发正确', async () => {
    const b = new FakeBridge();
    b.defs = [{ filePath: '/ws/a.ts', range: range(10, 0, 10, 5) }];
    const tool = new LspTool({ getBridge: () => b });
    const r = await tool.execute(
      { operation: 'goto_definition', file_path: 'a.ts', line: 1, character: 1 },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(b.calls[0]?.kind).toBe('def');
    expect(r.content).toContain('Definitions');
  });

  it('find_references 透传 include_declaration', async () => {
    const b = new FakeBridge();
    b.refs = [{ filePath: '/ws/a.ts', range: range(1, 1, 1, 2) }];
    const tool = new LspTool({ getBridge: () => b });
    await tool.execute(
      {
        operation: 'find_references',
        file_path: 'a.ts',
        line: 1,
        character: 1,
        include_declaration: false,
      },
      ctx(),
    );
    expect(b.calls[0]?.kind).toBe('ref');
    expect(b.calls[0]?.args[2]).toBe(false);
  });

  it('document_symbol 分发', async () => {
    const b = new FakeBridge();
    b.docSyms = [
      {
        name: 'Foo',
        kind: 'class',
        location: { filePath: '/ws/a.ts', range: range(0, 0, 10, 0) },
      },
    ];
    const tool = new LspTool({ getBridge: () => b });
    const r = await tool.execute({ operation: 'document_symbol', file_path: 'a.ts' }, ctx());
    expect(r.ok).toBe(true);
    expect(b.calls[0]?.kind).toBe('docSym');
  });

  it('workspace_symbol 分发 + limit 透传', async () => {
    const b = new FakeBridge();
    const tool = new LspTool({ getBridge: () => b });
    await tool.execute(
      { operation: 'workspace_symbol', query: 'Foo', limit: 50 },
      ctx(),
    );
    expect(b.calls[0]?.kind).toBe('wsSym');
    expect(b.calls[0]?.args).toEqual(['Foo', 50]);
  });

  it('goto_implementation 分发', async () => {
    const b = new FakeBridge();
    const tool = new LspTool({ getBridge: () => b });
    await tool.execute(
      { operation: 'goto_implementation', file_path: 'a.ts', line: 2, character: 3 },
      ctx(),
    );
    expect(b.calls[0]?.kind).toBe('impl');
  });

  it('call_hierarchy 默认 direction=incoming', async () => {
    const b = new FakeBridge();
    const tool = new LspTool({ getBridge: () => b });
    await tool.execute(
      { operation: 'call_hierarchy', file_path: 'a.ts', line: 1, character: 1 },
      ctx(),
    );
    expect(b.calls[0]?.kind).toBe('callHier');
    expect(b.calls[0]?.args[2]).toBe('incoming');
  });

  it('call_hierarchy 传入 outgoing', async () => {
    const b = new FakeBridge();
    const tool = new LspTool({ getBridge: () => b });
    await tool.execute(
      {
        operation: 'call_hierarchy',
        file_path: 'a.ts',
        line: 1,
        character: 1,
        direction: 'outgoing',
      },
      ctx(),
    );
    expect(b.calls[0]?.args[2]).toBe('outgoing');
  });

  it('bridge 未就绪 → LSP_SERVER_NOT_RUNNING', async () => {
    const tool = new LspTool({ getBridge: () => undefined });
    const r = await tool.execute(
      { operation: 'goto_definition', file_path: 'a.ts', line: 1, character: 1 },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.LSP_SERVER_NOT_RUNNING);
  });
});
