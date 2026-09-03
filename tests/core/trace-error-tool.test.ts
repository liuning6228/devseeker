/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * trace_error 工具单测（Debug Mode 优化方案 S1；P0-2 升级为四节一步取证报告）
 *
 * 通过 Fake LspBridge / Fake ProblemsBridge 注入，不依赖 VSCode / 真实语言服务器。
 */

import { describe, it, expect } from 'vitest';
import { TraceErrorTool } from '../../src/core/tools/index.js';
import type { LspBridge, LspLocation, CallHierarchyEntry } from '../../src/core/lsp/bridge.js';
import type {
  DiagnosticItem,
  GetDiagnosticsOptions,
  ProblemsBridge,
} from '../../src/core/problems/index.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

/** P0-2 · 假问题桥接器：注入预设诊断，记录查询选项 */
class FakeProblemsBridge implements ProblemsBridge {
  diags: DiagnosticItem[] = [];
  calls: GetDiagnosticsOptions[] = [];

  async getDiagnostics(opts?: GetDiagnosticsOptions): Promise<DiagnosticItem[]> {
    if (opts) this.calls.push(opts);
    return this.diags;
  }
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

  it('returns structured four-section report when bridge returns empty', async () => {
    const bridge = new FakeBridge();
    const tool = new TraceErrorTool({ getBridge: () => bridge });
    const r = await tool.execute(
      { errorMessage: 'Cannot read properties of undefined', failingFile: 'src/x.ts', failingLine: 42 },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Trace Report for src/x.ts:42');
    expect(r.content).toContain('Cannot read properties of undefined');
    // P0-2 · 四节固定结构：失败点 → 调用链 → 诊断 → 测试线索
    expect(r.content).toContain('### 1. 失败点');
    expect(r.content).toContain('### 2. 调用链');
    expect(r.content).toContain('### 3. 文件诊断');
    expect(r.content).toContain('### 4. 测试线索');
    // 无 problems bridge → 诊断节降级为提示而非失败
    expect(r.content).toContain('（诊断桥接器未就绪，跳过）');
    expect(r.content).not.toContain('根因假设');
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

  it('appends file diagnostics section from problems bridge', async () => {
    const bridge = new FakeBridge();
    const pbridge = new FakeProblemsBridge();
    pbridge.diags = [
      {
        filePath: 'src/x.ts',
        severity: 'error',
        message: "Cannot find name 'foo'",
        line: 42,
        character: 5,
        endLine: 42,
        endCharacter: 8,
        source: 'ts',
        code: 2304,
      },
      {
        filePath: 'src/x.ts',
        severity: 'error',
        message: "Type 'number' is not assignable",
        line: 43,
        character: 7,
        endLine: 43,
        endCharacter: 10,
      },
    ];

    const tool = new TraceErrorTool({
      getBridge: () => bridge,
      getProblemsBridge: () => pbridge,
    });
    const r = await tool.execute(
      { errorMessage: 'err', failingFile: 'src/x.ts', failingLine: 42 },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('### 3. 文件诊断');
    expect(r.content).toContain("Cannot find name 'foo'");
    expect(r.content).toContain('(ts 2304)');
    expect(r.content).toContain('src/x.ts:43:7');
    // 诊断查询按失败文件过滤 + error 级
    expect(pbridge.calls).toHaveLength(1);
    expect(pbridge.calls[0].filePaths).toEqual(['src/x.ts']);
    expect(pbridge.calls[0].minSeverity).toBe('error');
  });

  it('diagnostics section degrades gracefully when problems bridge read fails', async () => {
    const tool = new TraceErrorTool({
      getBridge: () => new FakeBridge(),
      getProblemsBridge: () => ({
        async getDiagnostics(): Promise<DiagnosticItem[]> {
          throw new Error('bridge exploded');
        },
      }),
    });
    const r = await tool.execute(
      { errorMessage: 'err', failingFile: 'src/x.ts', failingLine: 10 },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('诊断读取失败：bridge exploded');
  });

  it('finds related test files by naming convention (source file input)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-err-test-'));
    try {
      await fs.writeFile(path.join(tmp, 'foo.ts'), 'export function foo() {}\n');
      await fs.writeFile(
        path.join(tmp, 'foo.test.ts'),
        "import { foo } from './foo';\nit('works', () => expect(foo()).toBe(1));\n",
      );

      const tool = new TraceErrorTool({ getBridge: () => new FakeBridge() });
      const r = await tool.execute(
        { errorMessage: 'err', failingFile: 'foo.ts', failingLine: 1 },
        { ...ctx(), workspaceRoot: tmp },
      );
      expect(r.ok).toBe(true);
      expect(r.content).toContain('### 4. 测试线索');
      expect(r.content).toContain('foo.test.ts');
      expect(r.content).not.toContain('未发现相关测试文件');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('hints the covered source file when failing file is a test file', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-err-test-'));
    try {
      await fs.writeFile(path.join(tmp, 'bar.ts'), 'export const bar = 1;\n');
      await fs.writeFile(path.join(tmp, 'bar.spec.ts'), "import { bar } from './bar';\n");

      const tool = new TraceErrorTool({ getBridge: () => new FakeBridge() });
      const r = await tool.execute(
        { errorMessage: 'assertion failed', failingFile: 'bar.spec.ts', failingLine: 2 },
        { ...ctx(), workspaceRoot: tmp },
      );
      expect(r.ok).toBe(true);
      expect(r.content).toContain('当前文件是测试文件，推测被测源文件');
      expect(r.content).toContain('bar.ts');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('reports no test clues when nothing matches on disk', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-err-test-'));
    try {
      await fs.writeFile(path.join(tmp, 'only.ts'), 'export const only = 1;\n');

      const tool = new TraceErrorTool({ getBridge: () => new FakeBridge() });
      const r = await tool.execute(
        { errorMessage: 'err', failingFile: 'only.ts', failingLine: 1 },
        { ...ctx(), workspaceRoot: tmp },
      );
      expect(r.ok).toBe(true);
      expect(r.content).toContain('未发现相关测试文件');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
