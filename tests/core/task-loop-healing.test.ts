/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * tests/core/task-loop-healing.test.ts
 *
 * W7b5a 工具侧自愈集测：验证 TaskLoop 把 healing hint 正确注入 tool result。
 *
 * 场景：
 * 1. LLM 吐非法 JSON → tool_exec_end 不经 tool.execute 即返回 TOOL_ARGS_INVALID_JSON
 *    + contentPreview / 下一轮 tool 消息含 [Healing Hint 1/2]
 * 2. 工具返回 TOOL_PATCH_UNIQUE_FAIL → tool result 中注入 hint
 * 3. 同一工具连续 3 次 UNIQUE_FAIL，前 2 次挂 hint，第 3 次超预算不挂
 * 4. 成功执行后 healing 计数重置，再次 UNIQUE_FAIL 仍能 heal
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskLoop } from '../../src/core/task/loop.js';
import type { TaskEvent } from '../../src/core/task/events.js';
import type { IProvider } from '../../src/providers/base.js';
import type {
  Capability,
  CreateMessageOptions,
  Pricing,
  ProbeResult,
  StreamEvent,
} from '../../src/providers/types.js';
import {
  ToolRegistry,
  type ITool,
  type ToolResult,
} from '../../src/core/tools/index.js';
import { initLogger } from '../../src/infra/logger.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import * as os from 'node:os';
import * as path from 'node:path';

// ─────────── 可脚本化 Provider ───────────

class ScriptedProvider implements IProvider {
  readonly id = 'fake';
  readonly capabilities: readonly Capability[] = ['text', 'tool-use'];
  readonly contextWindow = 32_000;
  readonly pricing: Pricing = { inputPerMillion: 0, outputPerMillion: 0, currency: 'CNY' };

  private readonly scripts: StreamEvent[][] = [];
  public calls: CreateMessageOptions[] = [];

  push(events: StreamEvent[]) {
    this.scripts.push(events);
  }

  createMessage(options: CreateMessageOptions): AsyncIterable<StreamEvent> {
    this.calls.push(options);
    const events = this.scripts.shift() ?? [];
    return (async function* () {
      for (const ev of events) {
        yield ev;
      }
    })();
  }

  async probe(): Promise<ProbeResult> {
    return { ok: true, latencyMs: 0 };
  }

  async countTokens(): Promise<number> {
    return 0;
  }
}

/** 脚本化 search_replace 桩：每次被调用按 queue 返回结果。 */
class ScriptedSearchReplaceTool implements ITool<Record<string, unknown>, ToolResult> {
  readonly name = 'search_replace';
  readonly description = '';
  readonly parameters = {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  };
  readonly safetyLevel = 'workspace_write' as const;
  public executeCount = 0;
  private readonly queue: ToolResult[] = [];

  pushResult(r: ToolResult) {
    this.queue.push(r);
  }

  async execute(): Promise<ToolResult> {
    this.executeCount++;
    return (
      this.queue.shift() ?? { ok: false, content: 'no scripted result', errorCode: ErrorCodes.INTERNAL_UNKNOWN }
    );
  }
}

beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
});

describe('TaskLoop × tool-healing (W7b5a)', () => {
  it('场景 1：LLM 吐非法 JSON → tool.execute 不被调用，发出 TOOL_ARGS_INVALID_JSON + 注入 Healing Hint', async () => {
    const provider = new ScriptedProvider();
    // turn 1：LLM 返回非法 JSON arguments
    provider.push([
      { type: 'tool_start', id: 'call_1', name: 'search_replace' },
      {
        type: 'tool_args_delta',
        id: 'call_1',
        partial: '{"file_path":"/a.ts","old_string":"x",', // 未闭合
      },
      { type: 'tool_end', id: 'call_1' },
      { type: 'done', reason: 'tool_use' },
    ]);
    // turn 2：LLM 看到 hint 后给最终答复
    provider.push([
      { type: 'text_delta', text: 'I will fix JSON next' },
      { type: 'done', reason: 'stop' },
    ]);

    const tool = new ScriptedSearchReplaceTool();
    const registry = new ToolRegistry();
    registry.register(tool);

    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'x',
      onEvent: (e) => events.push(e),
    });

    await loop.send('edit file');

    // tool.execute 必须未被调用
    expect(tool.executeCount).toBe(0);

    // tool_exec_end：ok=false + errorCode=TOOL_ARGS_INVALID_JSON + preview 含 hint
    const execEnd = events.find((e) => e.type === 'tool_exec_end');
    expect(execEnd).toMatchObject({
      ok: false,
      name: 'search_replace',
      errorCode: ErrorCodes.TOOL_ARGS_INVALID_JSON,
    });
    const preview = (execEnd as { contentPreview: string }).contentPreview;
    expect(preview).toContain('[Healing Hint 1/2]');
    expect(preview).toContain('JSON 解析失败');

    // 下一轮 Provider 收到的历史中 tool 消息也应包含 hint
    expect(provider.calls).toHaveLength(2);
    const toolMsg = provider.calls[1].messages.find(
      (m) => m.role === 'tool' && m.toolCallId === 'call_1',
    );
    expect(toolMsg).toBeDefined();
    expect(String(toolMsg?.content)).toContain('[Healing Hint 1/2]');
  });

  it('场景 2：工具返回 TOOL_PATCH_UNIQUE_FAIL → 注入 hint 且 errorCode 透传', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'tool_start', id: 'call_1', name: 'search_replace' },
      {
        type: 'tool_args_delta',
        id: 'call_1',
        partial: '{"file_path":"/a.ts","old_string":"foo","new_string":"bar"}',
      },
      { type: 'tool_end', id: 'call_1' },
      { type: 'done', reason: 'tool_use' },
    ]);
    provider.push([
      { type: 'text_delta', text: 'will add context' },
      { type: 'done', reason: 'stop' },
    ]);

    const tool = new ScriptedSearchReplaceTool();
    tool.pushResult({
      ok: false,
      content: 'Error: old_string 在文件中出现 3 次',
      errorCode: ErrorCodes.TOOL_PATCH_UNIQUE_FAIL,
    });
    const registry = new ToolRegistry();
    registry.register(tool);

    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'x',
      onEvent: (e) => events.push(e),
    });

    await loop.send('edit file');

    expect(tool.executeCount).toBe(1);

    const execEnd = events.find((e) => e.type === 'tool_exec_end');
    expect(execEnd).toMatchObject({
      ok: false,
      errorCode: ErrorCodes.TOOL_PATCH_UNIQUE_FAIL,
    });
    const preview = (execEnd as { contentPreview: string }).contentPreview;
    expect(preview).toContain('Error: old_string 在文件中出现 3 次');
    expect(preview).toContain('[Healing Hint 1/2]');
    expect(preview).toContain('replace_all=true');

    const toolMsg = provider.calls[1].messages.find(
      (m) => m.role === 'tool' && m.toolCallId === 'call_1',
    );
    expect(String(toolMsg?.content)).toContain('[Healing Hint 1/2]');
  });

  it('场景 3：连续 3 次 UNIQUE_FAIL，前 2 次挂 hint，第 3 次超预算不挂', async () => {
    const provider = new ScriptedProvider();
    // 构造 3 轮连续 tool_use，一次单调用
    for (let i = 0; i < 3; i++) {
      provider.push([
        { type: 'tool_start', id: `c_${i}`, name: 'search_replace' },
        {
          type: 'tool_args_delta',
          id: `c_${i}`,
          partial: '{"file_path":"/a.ts","old_string":"foo","new_string":"bar"}',
        },
        { type: 'tool_end', id: `c_${i}` },
        { type: 'done', reason: 'tool_use' },
      ]);
    }
    // 最后一轮 LLM 放弃
    provider.push([
      { type: 'text_delta', text: 'giving up' },
      { type: 'done', reason: 'stop' },
    ]);

    const tool = new ScriptedSearchReplaceTool();
    for (let i = 0; i < 3; i++) {
      tool.pushResult({
        ok: false,
        content: `Error: dup #${i}`,
        errorCode: ErrorCodes.TOOL_PATCH_UNIQUE_FAIL,
      });
    }

    const registry = new ToolRegistry();
    registry.register(tool);

    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'x',
      maxTurns: 10,
      onEvent: (e) => events.push(e),
    });

    await loop.send('patch');

    const ends = events.filter((e) => e.type === 'tool_exec_end') as Array<
      TaskEvent & { contentPreview: string }
    >;
    expect(ends).toHaveLength(3);
    expect(ends[0].contentPreview).toContain('[Healing Hint 1/2]');
    expect(ends[1].contentPreview).toContain('[Healing Hint 2/2]');
    // 第 3 次超预算：原始错误文本保留，但不应再出现 Healing Hint 标签
    expect(ends[2].contentPreview).toContain('Error: dup #2');
    expect(ends[2].contentPreview).not.toContain('[Healing Hint');
  });

  it('场景 4：成功执行后 healing 计数重置，再次失败可重新 heal', async () => {
    const provider = new ScriptedProvider();
    // 3 轮 tool_use：失败 -> 成功 -> 失败
    for (let i = 0; i < 3; i++) {
      provider.push([
        { type: 'tool_start', id: `c_${i}`, name: 'search_replace' },
        {
          type: 'tool_args_delta',
          id: `c_${i}`,
          partial: '{"file_path":"/a.ts","old_string":"foo","new_string":"bar"}',
        },
        { type: 'tool_end', id: `c_${i}` },
        { type: 'done', reason: 'tool_use' },
      ]);
    }
    provider.push([
      { type: 'text_delta', text: 'done' },
      { type: 'done', reason: 'stop' },
    ]);

    const tool = new ScriptedSearchReplaceTool();
    tool.pushResult({
      ok: false,
      content: 'Error: dup first',
      errorCode: ErrorCodes.TOOL_PATCH_UNIQUE_FAIL,
    });
    tool.pushResult({ ok: true, content: 'OK' });
    tool.pushResult({
      ok: false,
      content: 'Error: dup again',
      errorCode: ErrorCodes.TOOL_PATCH_UNIQUE_FAIL,
    });

    const registry = new ToolRegistry();
    registry.register(tool);

    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'x',
      maxTurns: 10,
      onEvent: (e) => events.push(e),
    });

    await loop.send('patch');

    const ends = events.filter((e) => e.type === 'tool_exec_end') as Array<
      TaskEvent & { contentPreview: string; ok: boolean }
    >;
    expect(ends).toHaveLength(3);
    expect(ends[0].contentPreview).toContain('[Healing Hint 1/2]');
    expect(ends[1].ok).toBe(true);
    // 第 3 次：成功后预算重置 → 仍是 1/2
    expect(ends[2].contentPreview).toContain('[Healing Hint 1/2]');
  });

  it('场景 5：连续 3 次失败后，第 4 轮 system prompt 注入 heuristic 约束（§8.12.1 W15.3）', async () => {
    const provider = new ScriptedProvider();
    // 4 轮 tool_use：失败 -> 失败 -> 失败 -> 成功（threshold=3）
    for (let i = 0; i < 4; i++) {
      provider.push([
        { type: 'tool_start', id: `c_${i}`, name: 'search_replace' },
        {
          type: 'tool_args_delta',
          id: `c_${i}`,
          partial: '{"file_path":"/a.ts","old_string":"foo","new_string":"bar"}',
        },
        { type: 'tool_end', id: `c_${i}` },
        { type: 'done', reason: 'tool_use' },
      ]);
    }
    provider.push([
      { type: 'text_delta', text: 'done' },
      { type: 'done', reason: 'stop' },
    ]);

    const tool = new ScriptedSearchReplaceTool();
    tool.pushResult({ ok: false, content: 'Error: dup #0', errorCode: ErrorCodes.TOOL_PATCH_UNIQUE_FAIL });
    tool.pushResult({ ok: false, content: 'Error: dup #1', errorCode: ErrorCodes.TOOL_PATCH_UNIQUE_FAIL });
    tool.pushResult({ ok: false, content: 'Error: dup #2', errorCode: ErrorCodes.TOOL_PATCH_UNIQUE_FAIL });
    tool.pushResult({ ok: true, content: 'OK' });

    const registry = new ToolRegistry();
    registry.register(tool);

    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'SYS_BASE',
      maxTurns: 10,
    });

    await loop.send('patch');

    // provider.calls[0] = turn1 (user + system)
    // provider.calls[1] = turn2 — 1 次失败，未达阈值
    // provider.calls[2] = turn3 — 2 次失败，未达阈值
    // provider.calls[3] = turn4 — 3 次失败，达阈值，system prompt 应含约束
    // provider.calls[4] = turn5 — 成功，约束应已清除
    expect(provider.calls).toHaveLength(5);

    // turn2 (calls[1])：1 次失败，不应有约束
    const sys1 = provider.calls[1].messages[0];
    expect(sys1?.role).toBe('system');
    expect(String(sys1?.content)).not.toContain('<heuristic');

    // turn3 (calls[2])：2 次失败，不应有约束
    const sys2 = provider.calls[2].messages[0];
    expect(sys2?.role).toBe('system');
    expect(String(sys2?.content)).not.toContain('<heuristic');

    // turn4 (calls[3])：3 次失败，达阈值，应有约束
    const sys3 = provider.calls[3].messages[0];
    expect(sys3?.role).toBe('system');
    expect(String(sys3?.content)).toContain('<heuristic');

    // turn5 (calls[4])：成功执行后约束清除
    const sys4 = provider.calls[4].messages[0];
    expect(sys4?.role).toBe('system');
    expect(String(sys4?.content)).not.toContain('<heuristic');
  });

  it('场景 6：JSON 解析失败 3 次后注入对应约束（§8.12.1 W15.3）', async () => {
    const provider = new ScriptedProvider();
    // 3 轮：LLM 都吐非法 JSON（threshold=3 达标）
    for (let i = 0; i < 3; i++) {
      provider.push([
        { type: 'tool_start', id: `c_${i}`, name: 'search_replace' },
        { type: 'tool_args_delta', id: `c_${i}`, partial: '{"unclosed":' },
        { type: 'tool_end', id: `c_${i}` },
        { type: 'done', reason: 'tool_use' },
      ]);
    }
    // 第 4 轮 LLM 改正
    provider.push([
      { type: 'text_delta', text: 'fixed' },
      { type: 'done', reason: 'stop' },
    ]);

    const registry = new ToolRegistry();
    registry.register(new ScriptedSearchReplaceTool());

    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'SYS',
      maxTurns: 10,
    });

    await loop.send('patch');

    // calls[0] = turn1, calls[1] = turn2（1 次 JSON 失败）
    // calls[2] = turn3（2 次 JSON 失败，未达阈值）
    // calls[3] = turn4（3 次 JSON 失败，达阈值，应有约束）
    expect(provider.calls).toHaveLength(4);

    const sysWithConstraint = provider.calls[3].messages[0];
    expect(sysWithConstraint?.role).toBe('system');
    expect(String(sysWithConstraint?.content)).toContain('<heuristic');
    expect(String(sysWithConstraint?.content)).toContain('严格合法 JSON');
  });
});
