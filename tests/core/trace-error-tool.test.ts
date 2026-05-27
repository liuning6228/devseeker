/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * trace_error 工具单测（Debug Mode 优化方案 S1）
 *
 * 通过 Fake LspBridge 注入，不依赖 VSCode / 真实语言服务器。
 */

import { describe, it, expect } from 'vitest';
import { TraceErrorTool } from '../../src/core/tools/index.js';
import type { LspBridge, LspLocation, CallHierarchyEntry } from '../../src/core/lsp/bridge.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

function range(sl: number, sc: number, el: number, ec: number) {
  return {
    start: { line: sl, character: sc },
    end: { line: el, character: ec },
  };
}

class FakeBridge implements LspBridge {
  defs: LspLocation[] = [];
  callHier: CallHierarchyEntry[] = [];
  refs: LspLocation[] = [];
  calls: Array<{ kind: string; args: unknown[] }> = [];

  async goToDefinition(
    filePath: string,
    position: { line: number; character: number },
  ): Promise<LspLocation[]> {
    this.calls.push({ kind: 'goToDefinition', args: [filePath, position] });
    return this.defs;
  }

  async callHierarchy(
    filePath: string,
    position: { line: number; character: number },
    direction: 'incoming' | 'outgoing',
  ): Promise<CallHierarchyEntry[]> {
    this.calls.push({ kind: 'callHierarchy', args: [filePath, position, direction] });
    return this.callHier;
  }

  async findReferences(
    filePath: string,
    position: { line: number; character: number },
    includeDeclaration?: boolean,
  ): Promise<LspLocation[]> {
    this.calls.push({ kind: 'findReferences', args: [filePath, position, includeDeclaration] });
    return this.refs;
  }

  // 以下方法在此测试中用不到，但接口必须实现
  async documentSymbols(): Promise<never[]> { return []; }
  async workspaceSymbols(): Promise<never[]> { return []; }
  async goToImplementation(): Promise<never[]> { return []; }
}

function ctx() {
  return {
    signal: new AbortController().signal,
    workspaceRoot: '/test',
    taskId: 't1',
    toolCallId: 'c1',
  };
}

describe('TraceErrorTool', () => {
  it('rejects empty errorMessage', async () => {
    const bridge = new FakeBridge();
    const tool = new TraceErrorTool({ getBridge: () => bridge });
    const r = await tool.execute(
      { errorMessage: '', failingFile: 'src/x.ts', failingLine: 10 },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects empty failingFile', async () => {
    const bridge = new FakeBridge();
    const tool = new TraceErrorTool({ getBridge: () => bridge });
    const r = await tool.execute(
      { errorMessage: 'err', failingFile: '', failingLine: 10 },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects invalid failingLine', async () => {
    const bridge = new FakeBridge();
    const tool = new TraceErrorTool({ getBridge: () => bridge });
    const r = await tool.execute(
      { errorMessage: 'err', failingFile: 'src/x.ts', failingLine: 0 },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('returns structured report when bridge returns empty', async () => {
    const bridge = new FakeBridge();
    const tool = new TraceErrorTool({ getBridge: () => bridge });
    const r = await tool.execute(
      { errorMessage: 'Cannot read properties of undefined', failingFile: 'src/x.ts', failingLine: 42 },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Trace Report for src/x.ts:42');
    expect(r.content).toContain('Cannot read properties of undefined');
    expect(r.content).toContain('失败点');
    expect(r.content).toContain('调用链');
    expect(r.content).toContain('数据流');
    expect(r.content).toContain('根因假设');
    // 验证调用了 LSP
    expect(bridge.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('traces call hierarchy with depth=1', async () => {
    const bridge = new FakeBridge();
    bridge.defs = [{ filePath: 'src/x.ts', range: range(50, 1, 50, 10) }];
    bridge.callHier = [
      {
        name: 'handleSubmit',
        kind: 'function',
        location: { filePath: 'src/main.ts', range: range(100, 1, 100, 20) },
        fromRanges: [{ start: { line: 105, character: 3 }, end: { line: 105, character: 15 } }],
      },
    ];

    const tool = new TraceErrorTool({ getBridge: () => bridge });
    const r = await tool.execute(
      { errorMessage: 'Cannot read properties of undefined', failingFile: 'src/x.ts', failingLine: 42, depth: 1 },
      ctx(),
    );
    expect(r.ok).toBe(true);
    // 应该包含上游调用者
    expect(r.content).toContain('handleSubmit');
    expect(r.content).toContain('src/main.ts:100');
    // 至少调用了 goto_definition + call_hierarchy
    const gd = bridge.calls.filter((c) => c.kind === 'goToDefinition');
    const ch = bridge.calls.filter((c) => c.kind === 'callHierarchy');
    expect(gd.length).toBeGreaterThanOrEqual(1);
    expect(ch.length).toBeGreaterThanOrEqual(1);
  });

  it('fails gracefully when no LSP bridge', async () => {
    const tool = new TraceErrorTool({ getBridge: () => undefined });
    const r = await tool.execute(
      { errorMessage: 'err', failingFile: 'src/x.ts', failingLine: 10 },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.LSP_SERVER_NOT_RUNNING);
  });

  it('respects abort signal', async () => {
    const bridge = new FakeBridge();
    const tool = new TraceErrorTool({ getBridge: () => bridge });
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await tool.execute(
      { errorMessage: 'err', failingFile: 'src/x.ts', failingLine: 10 },
      { ...ctx(), signal: ctrl.signal },
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TASK_LOOP_ABORTED);
  });
});
