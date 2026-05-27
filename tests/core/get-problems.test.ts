/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * get_problems 工具单测（W7e1）
 *
 * 通过 Fake ProblemsBridge 注入，不依赖 VSCode。
 */

import { describe, it, expect } from 'vitest';
import { GetProblemsTool } from '../../src/core/tools/index.js';
import type {
  DiagnosticItem,
  GetDiagnosticsOptions,
  ProblemsBridge,
} from '../../src/core/problems/bridge.js';
import { ErrorCodes, AgentError } from '../../src/core/errors/index.js';

class FakeBridge implements ProblemsBridge {
  items: DiagnosticItem[] = [];
  calls: GetDiagnosticsOptions[] = [];
  throwErr?: unknown;

  async getDiagnostics(opts: GetDiagnosticsOptions = {}): Promise<DiagnosticItem[]> {
    this.calls.push(opts);
    if (this.throwErr) throw this.throwErr;
    // 模拟桥接器自带的 severity+file+line 排序
    const sevOrder: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };
    return [...this.items].sort((a, b) => {
      const s = sevOrder[a.severity] - sevOrder[b.severity];
      if (s !== 0) return s;
      const f = a.filePath.localeCompare(b.filePath);
      if (f !== 0) return f;
      return a.line - b.line;
    });
  }
}

function diag(partial: Partial<DiagnosticItem>): DiagnosticItem {
  return {
    filePath: 'src/a.ts',
    severity: 'error',
    message: 'something wrong',
    line: 1,
    character: 1,
    endLine: 1,
    endCharacter: 2,
    ...partial,
  };
}

function ctx(signal?: AbortSignal) {
  return {
    workspaceRoot: '/tmp/ws',
    signal: signal ?? new AbortController().signal,
    taskId: 't1',
    toolCallId: 'c1',
  };
}

describe('GetProblemsTool', () => {
  it('returns "0 total" on empty workspace', async () => {
    const bridge = new FakeBridge();
    const t = new GetProblemsTool({ getBridge: () => bridge });
    const r = await t.execute({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/0 total/);
    expect(r.display).toMatchObject({ total: 0 });
  });

  it('formats each diagnostic with severity tag, location, source and code', async () => {
    const bridge = new FakeBridge();
    bridge.items = [
      diag({
        filePath: 'src/a.ts',
        severity: 'error',
        line: 10,
        character: 5,
        message: "Cannot find name 'foo'.",
        source: 'ts',
        code: 2304,
      }),
      diag({
        filePath: 'src/b.ts',
        severity: 'warning',
        line: 3,
        character: 1,
        message: "'bar' is defined but never used.",
        source: 'eslint',
        code: 'no-unused-vars',
      }),
    ];
    const t = new GetProblemsTool({ getBridge: () => bridge });
    const r = await t.execute({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('[error] src/a.ts:10:5');
    expect(r.content).toContain("Cannot find name 'foo'.");
    expect(r.content).toContain('(ts 2304)');
    expect(r.content).toContain('[warning] src/b.ts:3:1');
    expect(r.content).toContain('(eslint no-unused-vars)');
    expect(r.display).toMatchObject({
      total: 2,
      counts: { error: 1, warning: 1, info: 0, hint: 0 },
    });
  });

  it('applies limit and appends truncation hint', async () => {
    const bridge = new FakeBridge();
    for (let i = 0; i < 5; i++) {
      bridge.items.push(diag({ line: i + 1, message: `err${i}` }));
    }
    const t = new GetProblemsTool({ getBridge: () => bridge });
    const r = await t.execute({ limit: 2 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/showing 2/);
    expect(r.content).toMatch(/3 more omitted/);
    expect((r.display as { problems: unknown[] }).problems).toHaveLength(2);
  });

  it('passes file_paths and min_severity through to bridge', async () => {
    const bridge = new FakeBridge();
    const t = new GetProblemsTool({ getBridge: () => bridge });
    await t.execute(
      { file_paths: ['src/a.ts', 'src/b.ts'], min_severity: 'warning' },
      ctx(),
    );
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]).toEqual({
      filePaths: ['src/a.ts', 'src/b.ts'],
      minSeverity: 'warning',
    });
  });

  it('rejects invalid min_severity', async () => {
    const bridge = new FakeBridge();
    const t = new GetProblemsTool({ getBridge: () => bridge });
    const r = await t.execute(
      { min_severity: 'fatal' as unknown as 'error' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects limit out of range', async () => {
    const bridge = new FakeBridge();
    const t = new GetProblemsTool({ getBridge: () => bridge });
    const r1 = await t.execute({ limit: 0 }, ctx());
    expect(r1.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
    const r2 = await t.execute({ limit: 99999 }, ctx());
    expect(r2.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects non-string file_paths entry', async () => {
    const bridge = new FakeBridge();
    const t = new GetProblemsTool({ getBridge: () => bridge });
    const r = await t.execute(
      { file_paths: ['ok.ts', ''] },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('fails with LSP_SERVER_NOT_RUNNING when bridge not available', async () => {
    const t = new GetProblemsTool({ getBridge: () => undefined });
    const r = await t.execute({}, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.LSP_SERVER_NOT_RUNNING);
  });

  it('respects aborted signal', async () => {
    const bridge = new FakeBridge();
    const t = new GetProblemsTool({ getBridge: () => bridge });
    const ac = new AbortController();
    ac.abort();
    const r = await t.execute({}, ctx(ac.signal));
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TASK_LOOP_ABORTED);
  });

  it('surfaces AgentError from bridge with original code', async () => {
    const bridge = new FakeBridge();
    bridge.throwErr = new AgentError({
      code: ErrorCodes.LSP_TIMEOUT,
      message: 'boom',
    });
    const t = new GetProblemsTool({ getBridge: () => bridge });
    const r = await t.execute({}, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.LSP_TIMEOUT);
    expect(r.content).toContain('boom');
  });

  it('wraps unknown errors as TOOL_EXEC_FAILED', async () => {
    const bridge = new FakeBridge();
    bridge.throwErr = new Error('kaboom');
    const t = new GetProblemsTool({ getBridge: () => bridge });
    const r = await t.execute({}, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_FAILED);
    expect(r.content).toContain('kaboom');
  });
});
