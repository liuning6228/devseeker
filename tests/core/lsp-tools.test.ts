/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * LSP 工具单测：goto_definition / find_references / document_symbol / workspace_symbol
 *                goto_implementation / call_hierarchy（W7e3 补齐）
 *
 * 通过 Fake LspBridge 注入，不依赖 VSCode / 真实语言服务器
 */

import { describe, it, expect } from 'vitest';
import {
  GoToDefinitionTool,
  FindReferencesTool,
  DocumentSymbolTool,
  WorkspaceSymbolTool,
  GoToImplementationTool,
  CallHierarchyTool,
} from '../../src/core/tools/index.js';
import type {
  LspBridge,
  LspLocation,
  LspPosition,
  LspSymbol,
  CallHierarchyEntry,
} from '../../src/core/lsp/bridge.js';
import { ErrorCodes, AgentError } from '../../src/core/errors/index.js';

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
  throwErr?: unknown;

  async goToDefinition(filePath: string, pos: LspPosition): Promise<LspLocation[]> {
    this.calls.push({ kind: 'def', args: [filePath, pos] });
    if (this.throwErr) throw this.throwErr;
    return this.defs;
  }
  async findReferences(filePath: string, pos: LspPosition, incl?: boolean): Promise<LspLocation[]> {
    this.calls.push({ kind: 'ref', args: [filePath, pos, incl] });
    if (this.throwErr) throw this.throwErr;
    return this.refs;
  }
  async documentSymbols(filePath: string): Promise<LspSymbol[]> {
    this.calls.push({ kind: 'docSym', args: [filePath] });
    if (this.throwErr) throw this.throwErr;
    return this.docSyms;
  }
  async workspaceSymbols(query: string, limit?: number): Promise<LspSymbol[]> {
    this.calls.push({ kind: 'wsSym', args: [query, limit] });
    if (this.throwErr) throw this.throwErr;
    return this.wsSyms;
  }
  async goToImplementation(filePath: string, pos: LspPosition): Promise<LspLocation[]> {
    this.calls.push({ kind: 'impl', args: [filePath, pos] });
    if (this.throwErr) throw this.throwErr;
    return this.impls;
  }
  async callHierarchy(
    filePath: string,
    pos: LspPosition,
    direction: 'incoming' | 'outgoing',
  ): Promise<CallHierarchyEntry[]> {
    this.calls.push({ kind: 'callHier', args: [filePath, pos, direction] });
    if (this.throwErr) throw this.throwErr;
    return this.callHier;
  }
}

function ctx(signal?: AbortSignal) {
  return {
    workspaceRoot: '/tmp/ws',
    signal: signal ?? new AbortController().signal,
    taskId: 't1',
    toolCallId: 'c1',
  };
}

describe('GoToDefinitionTool', () => {
  it('fails on empty file_path', async () => {
    const t = new GoToDefinitionTool({ getBridge: () => new FakeBridge() });
    const r = await t.execute({ file_path: ' ', line: 1, character: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('fails on non-integer line', async () => {
    const t = new GoToDefinitionTool({ getBridge: () => new FakeBridge() });
    const r = await t.execute({ file_path: 'a.ts', line: 0, character: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('fails with LSP_SERVER_NOT_RUNNING when bridge is undefined', async () => {
    const t = new GoToDefinitionTool({ getBridge: () => undefined });
    const r = await t.execute({ file_path: 'a.ts', line: 1, character: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.LSP_SERVER_NOT_RUNNING);
  });

  it('returns 0 results header when no definitions', async () => {
    const bridge = new FakeBridge();
    const t = new GoToDefinitionTool({ getBridge: () => bridge });
    const r = await t.execute({ file_path: 'a.ts', line: 5, character: 3 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Definitions for a.ts:5:3');
    expect(r.content).toContain('0 results');
    expect(r.display?.count).toBe(0);
  });

  it('formats definition locations with 1-based coords', async () => {
    const bridge = new FakeBridge();
    bridge.defs = [
      { filePath: 'src/a.ts', range: range(10, 4, 10, 20) },
      { filePath: 'src/b.ts', range: range(3, 1, 3, 7) },
    ];
    const t = new GoToDefinitionTool({ getBridge: () => bridge });
    const r = await t.execute({ file_path: 'foo.ts', line: 1, character: 2 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('2 results');
    expect(r.content).toContain('src/a.ts:10:4-10:20');
    expect(r.content).toContain('src/b.ts:3:1-3:7');
    expect(r.display?.count).toBe(2);
  });

  it('returns ABORTED when signal aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const t = new GoToDefinitionTool({ getBridge: () => new FakeBridge() });
    const r = await t.execute({ file_path: 'a.ts', line: 1, character: 1 }, ctx(ctl.signal));
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TASK_LOOP_ABORTED);
  });

  it('propagates LSP_TIMEOUT from bridge', async () => {
    const bridge = new FakeBridge();
    bridge.throwErr = new AgentError({
      code: ErrorCodes.LSP_TIMEOUT,
      message: 'timeout',
    });
    const t = new GoToDefinitionTool({ getBridge: () => bridge });
    const r = await t.execute({ file_path: 'a.ts', line: 1, character: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.LSP_TIMEOUT);
  });
});

describe('FindReferencesTool', () => {
  it('passes include_declaration default true to bridge', async () => {
    const bridge = new FakeBridge();
    bridge.refs = [{ filePath: 'x.ts', range: range(1, 1, 1, 5) }];
    const t = new FindReferencesTool({ getBridge: () => bridge });
    const r = await t.execute({ file_path: 'a.ts', line: 2, character: 3 }, ctx());
    expect(r.ok).toBe(true);
    expect(bridge.calls[0].args[2]).toBe(true);
    expect(r.content).toContain('References for a.ts:2:3');
    expect(r.content).toContain('x.ts:1:1-1:5');
  });

  it('honors include_declaration=false', async () => {
    const bridge = new FakeBridge();
    const t = new FindReferencesTool({ getBridge: () => bridge });
    await t.execute(
      { file_path: 'a.ts', line: 1, character: 1, include_declaration: false },
      ctx(),
    );
    expect(bridge.calls[0].args[2]).toBe(false);
  });
});

describe('DocumentSymbolTool', () => {
  it('fails on empty file_path', async () => {
    const t = new DocumentSymbolTool({ getBridge: () => new FakeBridge() });
    const r = await t.execute({ file_path: '' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('formats symbols with containerName prefix', async () => {
    const bridge = new FakeBridge();
    bridge.docSyms = [
      {
        name: 'Foo',
        kind: 'class',
        location: { filePath: 'a.ts', range: range(1, 1, 10, 2) },
      },
      {
        name: 'bar',
        kind: 'method',
        containerName: 'Foo',
        location: { filePath: 'a.ts', range: range(3, 3, 5, 4) },
      },
    ];
    const t = new DocumentSymbolTool({ getBridge: () => bridge });
    const r = await t.execute({ file_path: 'a.ts' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Symbols in a.ts');
    expect(r.content).toContain('2 symbols');
    expect(r.content).toContain('[class] Foo @ a.ts:1:1');
    expect(r.content).toContain('[method] Foo.bar @ a.ts:3:3');
  });

  it('fails with LSP_SERVER_NOT_RUNNING when bridge is undefined', async () => {
    const t = new DocumentSymbolTool({ getBridge: () => undefined });
    const r = await t.execute({ file_path: 'a.ts' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.LSP_SERVER_NOT_RUNNING);
  });
});

describe('WorkspaceSymbolTool', () => {
  it('fails on empty query', async () => {
    const t = new WorkspaceSymbolTool({ getBridge: () => new FakeBridge() });
    const r = await t.execute({ query: '  ' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('clamps limit to [1, 200]', async () => {
    const bridge = new FakeBridge();
    const t = new WorkspaceSymbolTool({ getBridge: () => bridge });
    await t.execute({ query: 'x', limit: 0 }, ctx());
    expect(bridge.calls[0].args[1]).toBe(1);
    await t.execute({ query: 'x', limit: 9999 }, ctx());
    expect(bridge.calls[1].args[1]).toBe(200);
  });

  it('defaults limit to 50', async () => {
    const bridge = new FakeBridge();
    const t = new WorkspaceSymbolTool({ getBridge: () => bridge });
    await t.execute({ query: 'TaskLoop' }, ctx());
    expect(bridge.calls[0].args[1]).toBe(50);
  });

  it('formats workspace symbols with header', async () => {
    const bridge = new FakeBridge();
    bridge.wsSyms = [
      {
        name: 'TaskLoop',
        kind: 'class',
        location: { filePath: 'src/core/task/loop.ts', range: range(12, 14, 12, 22) },
      },
    ];
    const t = new WorkspaceSymbolTool({ getBridge: () => bridge });
    const r = await t.execute({ query: 'TaskLoop' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Workspace symbols matching "TaskLoop"');
    expect(r.content).toContain('[class] TaskLoop @ src/core/task/loop.ts:12:14');
  });
});

// ─── W7e3: goto_implementation + call_hierarchy ───

describe('GoToImplementationTool', () => {
  it('fails on empty file_path', async () => {
    const t = new GoToImplementationTool({ getBridge: () => new FakeBridge() });
    const r = await t.execute({ file_path: ' ', line: 1, character: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('fails with LSP_SERVER_NOT_RUNNING when bridge is undefined', async () => {
    const t = new GoToImplementationTool({ getBridge: () => undefined });
    const r = await t.execute({ file_path: 'a.ts', line: 1, character: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.LSP_SERVER_NOT_RUNNING);
  });

  it('returns 0 results when no implementations', async () => {
    const bridge = new FakeBridge();
    const t = new GoToImplementationTool({ getBridge: () => bridge });
    const r = await t.execute({ file_path: 'iface.ts', line: 5, character: 3 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Implementations for iface.ts:5:3');
    expect(r.content).toContain('0 results');
  });

  it('formats implementation locations with 1-based coords', async () => {
    const bridge = new FakeBridge();
    bridge.impls = [
      { filePath: 'src/impl-a.ts', range: range(20, 1, 20, 30) },
      { filePath: 'src/impl-b.ts', range: range(8, 5, 8, 15) },
    ];
    const t = new GoToImplementationTool({ getBridge: () => bridge });
    const r = await t.execute({ file_path: 'iface.ts', line: 1, character: 1 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('2 results');
    expect(r.content).toContain('src/impl-a.ts:20:1-20:30');
    expect(r.content).toContain('src/impl-b.ts:8:5-8:15');
    expect(r.display?.count).toBe(2);
  });

  it('propagates AgentError from bridge', async () => {
    const bridge = new FakeBridge();
    bridge.throwErr = new AgentError({ code: ErrorCodes.LSP_TIMEOUT, message: 'timeout' });
    const t = new GoToImplementationTool({ getBridge: () => bridge });
    const r = await t.execute({ file_path: 'a.ts', line: 1, character: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.LSP_TIMEOUT);
  });
});

describe('CallHierarchyTool', () => {
  it('rejects invalid direction', async () => {
    const t = new CallHierarchyTool({ getBridge: () => new FakeBridge() });
    const r = await t.execute(
      { file_path: 'a.ts', line: 1, character: 1, direction: 'sideways' as 'incoming' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('fails with LSP_SERVER_NOT_RUNNING when bridge is undefined', async () => {
    const t = new CallHierarchyTool({ getBridge: () => undefined });
    const r = await t.execute(
      { file_path: 'a.ts', line: 1, character: 1, direction: 'incoming' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.LSP_SERVER_NOT_RUNNING);
  });

  it('returns 0 results when no callers', async () => {
    const bridge = new FakeBridge();
    const t = new CallHierarchyTool({ getBridge: () => bridge });
    const r = await t.execute(
      { file_path: 'fn.ts', line: 10, character: 5, direction: 'incoming' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Callers (incoming) for fn.ts:10:5');
    expect(r.content).toContain('0 results');
  });

  it('formats incoming callers with kind, name, location', async () => {
    const bridge = new FakeBridge();
    bridge.callHier = [
      {
        name: 'main',
        kind: 'function',
        location: { filePath: 'src/main.ts', range: range(5, 1, 5, 10) },
        fromRanges: [range(5, 3, 5, 7)],
      },
      {
        name: 'setup',
        kind: 'method',
        location: { filePath: 'src/app.ts', range: range(20, 5, 20, 20) },
      },
    ];
    const t = new CallHierarchyTool({ getBridge: () => bridge });
    const r = await t.execute(
      { file_path: 'fn.ts', line: 1, character: 1, direction: 'incoming' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('2 results');
    expect(r.content).toContain('[function] main — src/main.ts:5:1');
    expect(r.content).toContain('call sites: L5');
    expect(r.content).toContain('[method] setup — src/app.ts:20:5');
  });

  it('formats outgoing callees', async () => {
    const bridge = new FakeBridge();
    bridge.callHier = [
      {
        name: 'readFile',
        kind: 'function',
        location: { filePath: 'src/io.ts', range: range(3, 1, 3, 15) },
      },
    ];
    const t = new CallHierarchyTool({ getBridge: () => bridge });
    const r = await t.execute(
      { file_path: 'fn.ts', line: 1, character: 1, direction: 'outgoing' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Callees (outgoing)');
    expect(r.content).toContain('[function] readFile — src/io.ts:3:1');
  });

  it('passes direction to bridge correctly', async () => {
    const bridge = new FakeBridge();
    const t = new CallHierarchyTool({ getBridge: () => bridge });
    await t.execute(
      { file_path: 'a.ts', line: 1, character: 1, direction: 'outgoing' },
      ctx(),
    );
    expect(bridge.calls[0].args[2]).toBe('outgoing');
  });
});
