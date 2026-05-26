/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W11.9 · T16 金测（程序化覆盖门禁加分题）
 *
 * 场景：配置 `pre_tool_call` hook 匹配 `tool: bash`，让 hook 以 exit 1 拒绝。
 * 期望：用户侧调用 bash 工具被 HOOK_DENIED 拦截；实际 bash 子进程不启动。
 *
 * 与 hooks-integration.test 的区别：
 * - 专门针对 bash 工具（真实 tool 实例 + matcher）
 * - 覆盖 matcher.tool 过滤逻辑：非 bash 工具不应被这条 hook 拦截
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ToolRegistry,
  ToolRunner,
  type ITool,
  type ToolResult,
} from '../../src/core/tools/index.js';
import { BashTool } from '../../src/core/tools/bash.js';
import { HookManager } from '../../src/core/hooks/manager.js';
import type { HookPayload, HookRunResult, HookSpec } from '../../src/core/hooks/types.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import { initLogger } from '../../src/infra/logger.js';

class NoopReadTool implements ITool<Record<string, unknown>, ToolResult> {
  readonly name = 'noop_read';
  readonly description = 'n/a';
  readonly parameters = { type: 'object' as const, properties: {}, required: [] };
  readonly safetyLevel = 'read_only' as const;
  calls = 0;
  async execute(): Promise<ToolResult> {
    this.calls++;
    return { ok: true, content: 'done' };
  }
}

function scriptedRunner(
  script: Record<string, { ok: boolean; exitCode?: number }>,
): (spec: HookSpec, payload: HookPayload) => Promise<HookRunResult> {
  return async (spec) => {
    const key = spec.name ?? spec.command;
    const r = script[key] ?? { ok: true, exitCode: 0 };
    return {
      spec,
      ok: r.ok,
      exitCode: r.exitCode ?? (r.ok ? 0 : 1),
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
    };
  };
}

beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-t16-logs'),
    level: 'error',
    dev: false,
  });
});

describe('T16 · Hook pre_tool_call 拦截 bash（金测）', () => {
  it('matcher=bash 时：bash 被 HOOK_DENIED；bash 子进程未启动', async () => {
    // 传入一个会 throw 的 terminalPool，若 bash 真启动就会炸
    const explodingPool = {
      spawn: (() => {
        throw new Error('bash should never spawn under deny');
      }) as never,
      getOutput: (() => {
        throw new Error('not reachable');
      }) as never,
      kill: () => undefined,
    } as never;
    const bash = new BashTool({ terminalPool: explodingPool });
    const registry = new ToolRegistry();
    registry.register(bash);

    const hm = new HookManager({
      runner: scriptedRunner({ 'block-bash': { ok: false, exitCode: 1 } }),
    });
    hm.setConfig({
      hooks: [
        {
          event: 'pre_tool_call',
          command: 'echo blocked && exit 1',
          name: 'block-bash',
          match: { tool: 'bash' },
        },
      ],
    });

    const runner = new ToolRunner(registry, { hookManager: hm });
    const res = await runner.run({
      toolCallId: 'c1',
      name: 'bash',
      args: { command: 'git status' },
      workspaceRoot: undefined,
      signal: new AbortController().signal,
      taskId: 't1',
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.HOOK_DENIED);
  });

  it('matcher=bash 对其它工具不生效：非 bash 工具正常执行', async () => {
    const noop = new NoopReadTool();
    const registry = new ToolRegistry();
    registry.register(noop);

    const hm = new HookManager({
      runner: scriptedRunner({ 'block-bash': { ok: false, exitCode: 1 } }),
    });
    hm.setConfig({
      hooks: [
        {
          event: 'pre_tool_call',
          command: 'x',
          name: 'block-bash',
          match: { tool: 'bash' },
        },
      ],
    });

    const runner = new ToolRunner(registry, { hookManager: hm });
    const res = await runner.run({
      toolCallId: 'c2',
      name: 'noop_read',
      args: {},
      workspaceRoot: undefined,
      signal: new AbortController().signal,
      taskId: 't1',
    });

    expect(res.ok).toBe(true);
    expect(noop.calls).toBe(1);
  });
});
