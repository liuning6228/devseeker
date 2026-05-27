/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Hooks 子系统单测（W5 批次 1）
 *
 * 覆盖：
 * - parseHookConfig：合法 / JSONC 注释 / 非法字段 / 缺省事件
 * - HookManager：匹配 + 串行执行 + deny 语义 + runtime subscribe
 * - runHookCommand：真实 spawn 一次 node 内建命令做 sanity 检查（exit 0 / exit 1）
 */

import { describe, it, expect } from 'vitest';
import {
  parseHookConfig,
  HookManager,
  runHookCommand,
  type HookPayload,
  type HookSpec,
  type HookRunResult,
} from '../../src/core/hooks/index.js';

// ─────────── parseHookConfig ───────────

describe('parseHookConfig', () => {
  it('returns empty when input empty', () => {
    const r = parseHookConfig('');
    expect(r.config.hooks).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('strips // and /* */ comments', () => {
    const raw = `// top comment\n{\n  /* block */\n  "hooks": [\n    // nested\n    { "event": "pre_task", "command": "echo hi" }\n  ]\n}`;
    const r = parseHookConfig(raw);
    expect(r.error).toBeUndefined();
    expect(r.config.hooks).toHaveLength(1);
    expect(r.config.hooks[0].command).toBe('echo hi');
  });

  it('reports error on invalid event', () => {
    const raw = `{"hooks":[{"event":"never","command":"x"}]}`;
    const r = parseHookConfig(raw);
    expect(r.error).toMatch(/event must be one of/);
  });

  it('reports error on missing command', () => {
    const raw = `{"hooks":[{"event":"pre_task"}]}`;
    const r = parseHookConfig(raw);
    expect(r.error).toMatch(/command must be a non-empty/);
  });

  it('reports error on invalid match.safetyLevel', () => {
    const raw = `{"hooks":[{"event":"pre_tool_call","command":"x","match":{"safetyLevel":"boom"}}]}`;
    const r = parseHookConfig(raw);
    expect(r.error).toMatch(/safetyLevel must be/);
  });

  it('accepts full spec with match + timeout + deny + name', () => {
    const raw = `{"hooks":[{"event":"pre_tool_call","command":"guard.sh","match":{"tool":"bash","safetyLevel":"external"},"timeoutMs":5000,"deny":true,"name":"bash-guard"}]}`;
    const r = parseHookConfig(raw);
    expect(r.error).toBeUndefined();
    const spec = r.config.hooks[0];
    expect(spec.match).toEqual({ tool: 'bash', safetyLevel: 'external' });
    expect(spec.timeoutMs).toBe(5000);
    expect(spec.deny).toBe(true);
    expect(spec.name).toBe('bash-guard');
  });

  it('rejects non-array hooks', () => {
    const r = parseHookConfig(`{"hooks":123}`);
    expect(r.error).toMatch(/must be an array/);
  });
});

// ─────────── HookManager ───────────

type FakeRunnerArgs = { spec: HookSpec; payload: HookPayload };

function makeManager(
  config: { hooks: HookSpec[] },
  plan: Record<string, Partial<HookRunResult>> = {},
): { mgr: HookManager; calls: FakeRunnerArgs[] } {
  const calls: FakeRunnerArgs[] = [];
  const fakeRunner = async (spec: HookSpec, payload: HookPayload): Promise<HookRunResult> => {
    calls.push({ spec, payload });
    const key = spec.name ?? spec.command;
    const partial = plan[key] ?? {};
    return {
      spec,
      ok: partial.ok ?? true,
      exitCode: partial.exitCode ?? 0,
      stdout: partial.stdout ?? '',
      stderr: partial.stderr ?? '',
      durationMs: partial.durationMs ?? 1,
      timedOut: partial.timedOut ?? false,
    };
  };
  const mgr = new HookManager({ config, runner: fakeRunner });
  return { mgr, calls };
}

function preToolPayload(
  toolName: string,
  safetyLevel: 'read_only' | 'write' | 'external' = 'read_only',
): HookPayload {
  return {
    event: 'pre_tool_call',
    taskId: 't',
    timestamp: 0,
    toolName,
    safetyLevel,
    toolCallId: 'tc',
    argsJson: '{}',
  };
}

describe('HookManager', () => {
  it('selects only matching event', async () => {
    const { mgr } = makeManager({
      hooks: [
        { event: 'pre_task', command: 'pt', name: 'pt' },
        { event: 'pre_tool_call', command: 'ptc', name: 'ptc' },
      ],
    });
    const out = await mgr.emit(preToolPayload('read_file'));
    expect(out.results).toHaveLength(1);
    expect(out.results[0].spec.name).toBe('ptc');
  });

  it('matches by tool name and safetyLevel', async () => {
    const { mgr, calls } = makeManager({
      hooks: [
        { event: 'pre_tool_call', command: 'x', name: 'by-name', match: { tool: 'bash' } },
        {
          event: 'pre_tool_call',
          command: 'y',
          name: 'by-safety',
          match: { safetyLevel: 'external' },
        },
        {
          event: 'pre_tool_call',
          command: 'z',
          name: 'by-prefix',
          match: { tool: 'read_*' },
        },
      ],
    });
    await mgr.emit(preToolPayload('read_file', 'read_only'));
    expect(calls.map((c) => c.spec.name)).toEqual(['by-prefix']);
  });

  it('runs all matches serially when none denies', async () => {
    const { mgr, calls } = makeManager({
      hooks: [
        { event: 'post_tool_call', command: 'a', name: 'a' },
        { event: 'post_tool_call', command: 'b', name: 'b' },
      ],
    });
    const out = await mgr.emit({
      event: 'post_tool_call',
      taskId: 't',
      timestamp: 0,
      toolName: 'read_file',
      safetyLevel: 'read_only',
      toolCallId: 'tc',
      ok: true,
      resultPreview: '',
      durationMs: 1,
    });
    expect(calls.map((c) => c.spec.name)).toEqual(['a', 'b']);
    expect(out.denied).toBe(false);
    expect(out.results).toHaveLength(2);
  });

  it('denies on pre_tool_call non-zero exit (deny default true)', async () => {
    const { mgr, calls } = makeManager(
      {
        hooks: [
          { event: 'pre_tool_call', command: 'guard', name: 'guard' },
          { event: 'pre_tool_call', command: 'after', name: 'after' },
        ],
      },
      { guard: { ok: false, exitCode: 2 } },
    );
    const out = await mgr.emit(preToolPayload('bash', 'external'));
    expect(out.denied).toBe(true);
    expect(out.denier?.spec.name).toBe('guard');
    // 第二个 spec 不应被调用（denied 后中断）
    expect(calls.map((c) => c.spec.name)).toEqual(['guard']);
  });

  it('does NOT deny on post_tool_call even if non-zero', async () => {
    const { mgr } = makeManager(
      {
        hooks: [{ event: 'post_tool_call', command: 'x', name: 'x' }],
      },
      { x: { ok: false, exitCode: 3 } },
    );
    const out = await mgr.emit({
      event: 'post_tool_call',
      taskId: 't',
      timestamp: 0,
      toolName: 'read_file',
      safetyLevel: 'read_only',
      toolCallId: 'tc',
      ok: true,
      resultPreview: '',
      durationMs: 1,
    });
    expect(out.denied).toBe(false);
  });

  it('allows pre hook to opt-out of denying via deny:false', async () => {
    const { mgr, calls } = makeManager(
      {
        hooks: [
          { event: 'pre_tool_call', command: 'w', name: 'warn', deny: false },
          { event: 'pre_tool_call', command: 'a', name: 'after' },
        ],
      },
      { warn: { ok: false, exitCode: 1 } },
    );
    const out = await mgr.emit(preToolPayload('read_file'));
    expect(out.denied).toBe(false);
    expect(calls.map((c) => c.spec.name)).toEqual(['warn', 'after']);
  });

  it('subscribe() adds runtime hook and returns unsubscribe', async () => {
    const { mgr, calls } = makeManager({ hooks: [] });
    const off = mgr.subscribe({ event: 'pre_tool_call', command: 'rt', name: 'rt' });
    await mgr.emit(preToolPayload('read_file'));
    expect(calls.map((c) => c.spec.name)).toEqual(['rt']);
    off();
    calls.length = 0;
    await mgr.emit(preToolPayload('read_file'));
    expect(calls).toEqual([]);
  });
});

// ─────────── runHookCommand (smoke test) ───────────

describe('runHookCommand', () => {
  const exit0: HookSpec = {
    event: 'pre_task',
    command: 'node -e "process.exit(0)"',
    timeoutMs: 10_000,
  };
  const exit1: HookSpec = {
    event: 'pre_task',
    command: 'node -e "process.exit(3)"',
    timeoutMs: 10_000,
  };

  const payload: HookPayload = {
    event: 'pre_task',
    taskId: 't',
    timestamp: 0,
    userInput: 'hi',
  };

  it('exits 0 → ok=true', async () => {
    const r = await runHookCommand(exit0, payload);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('exits non-zero → ok=false with exitCode captured', async () => {
    const r = await runHookCommand(exit1, payload);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
  });

  it('enforces timeout', async () => {
    const slow: HookSpec = {
      event: 'pre_task',
      command: 'node -e "setTimeout(()=>{},5000)"',
      timeoutMs: 150,
    };
    const r = await runHookCommand(slow, payload);
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
  });
});
