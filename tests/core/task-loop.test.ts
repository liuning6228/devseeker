/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * TaskLoop 单测（最小闭环）
 *
 * 覆盖：
 * - 无工具调用：text_delta → assistant 消息 → task_end completed
 * - 工具调用：tool_use → ToolRunner.run → tool 消息回填 → 再一轮 → completed
 * - Provider error 事件：task_end error
 * - abort：task_end aborted
 * - max_turns 兜底
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskLoop } from '../../src/core/task/loop.js';
import type { TaskEvent } from '../../src/core/task/events.js';
import { ContextManager } from '../../src/core/context/index.js';
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

// ─────────── 可脚本化的假 Provider ───────────

class ScriptedProvider implements IProvider {
  readonly id = 'fake';
  readonly capabilities: readonly Capability[] = ['text', 'tool-use'];
  readonly contextWindow = 32_000;
  readonly pricing: Pricing = { inputPerMillion: 0, outputPerMillion: 0, currency: 'CNY' };

  /** 每次 createMessage 被调用时出队一组事件 */
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

class EchoTool implements ITool<{ text: string }, ToolResult> {
  readonly name = 'echo';
  readonly description = 'returns the text back';
  readonly parameters = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  };
  readonly safetyLevel = 'read_only' as const;
  async execute(args: { text: string }): Promise<ToolResult> {
    return { ok: true, content: `ECHO: ${args.text}` };
  }
}

beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
});

afterEach(() => {});

// ─────────── 测试 ───────────

describe('TaskLoop', () => {
  it('completes single turn without tool calls', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' World' },
      { type: 'usage', promptTokens: 5, completionTokens: 2 },
      { type: 'done', reason: 'stop' },
    ]);

    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'you are helpful',
      onEvent: (e) => events.push(e),
    });

    await loop.send('hi');

    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas).toHaveLength(2);

    const end = events[events.length - 1];
    expect(end).toMatchObject({ type: 'task_end', reason: 'completed' });

    const history = loop.getHistorySnapshot();
    expect(history[0]).toMatchObject({ role: 'system', content: 'you are helpful' });
    expect(history[1]).toMatchObject({ role: 'user', content: 'hi' });
    expect(history[2]).toMatchObject({ role: 'assistant', content: 'Hello World' });
  });

  it('executes tool call and loops back', async () => {
    const provider = new ScriptedProvider();
    // turn 1: 发起工具调用
    provider.push([
      { type: 'tool_start', id: 'call_1', name: 'echo' },
      { type: 'tool_args_delta', id: 'call_1', partial: '{"text":"hi"}' },
      { type: 'tool_end', id: 'call_1' },
      { type: 'done', reason: 'tool_use' },
    ]);
    // turn 2: 最终回答
    provider.push([
      { type: 'text_delta', text: 'Tool said: ECHO: hi' },
      { type: 'done', reason: 'stop' },
    ]);

    const registry = new ToolRegistry();
    registry.register(new EchoTool());

    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'x',
      onEvent: (e) => events.push(e),
    });

    await loop.send('call echo');

    // Provider 应被调用两次
    expect(provider.calls).toHaveLength(2);

    // 第二次 Provider 调用时，历史中应包含 tool 消息
    const secondCallMessages = provider.calls[1].messages;
    const hasToolMsg = secondCallMessages.some(
      (m) => m.role === 'tool' && m.toolCallId === 'call_1',
    );
    expect(hasToolMsg).toBe(true);

    // tool_exec_start / tool_exec_end 事件均发出
    expect(events.some((e) => e.type === 'tool_exec_start')).toBe(true);
    const execEnd = events.find((e) => e.type === 'tool_exec_end');
    expect(execEnd).toMatchObject({ ok: true, name: 'echo' });

    // 最终 task_end completed
    expect(events[events.length - 1]).toMatchObject({ type: 'task_end', reason: 'completed' });
  });

  it('ends with error when provider emits error event', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      {
        type: 'error',
        error: {
          code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY,
          message: 'bad key',
          retryable: false,
        },
      },
      { type: 'done', reason: 'error' },
    ]);

    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'x',
      onEvent: (e) => events.push(e),
    });

    await loop.send('go');

    const end = events[events.length - 1];
    expect(end).toMatchObject({
      type: 'task_end',
      reason: 'error',
      errorCode: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY,
    });
  });

  it('aborts mid-stream when abort() is called', async () => {
    // 构造一个永远不 done 的 provider
    const provider: IProvider = {
      id: 'slow',
      capabilities: ['text'],
      contextWindow: 1000,
      pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'CNY' },
      countTokens: async () => 0,
      probe: async () => ({ ok: true, latencyMs: 0 }),
      createMessage: ({ signal }) =>
        (async function* (): AsyncGenerator<StreamEvent> {
          // 等取消
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          // signal 已中断 —— 产生一个 done
          yield { type: 'done', reason: 'aborted' };
        })(),
    };

    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'x',
      onEvent: (e) => events.push(e),
    });

    const done = loop.send('hi');
    // 立即中止
    setTimeout(() => loop.abort(), 10);
    await done;

    const end = events[events.length - 1];
    expect(end).toMatchObject({ type: 'task_end', reason: 'aborted' });
  });

  it('toolFilter: blocks disallowed tool with UNSAFE_BLOCKED and never calls execute', async () => {
    const provider = new ScriptedProvider();
    // turn 1: 模型不顾 schema 直接调 echo（模拟 LLM 绕过过滤）
    provider.push([
      { type: 'tool_start', id: 'call_1', name: 'echo' },
      { type: 'tool_args_delta', id: 'call_1', partial: '{"text":"blocked"}' },
      { type: 'tool_end', id: 'call_1' },
      { type: 'done', reason: 'tool_use' },
    ]);
    // turn 2: 收到阻止结果后给个回复
    provider.push([
      { type: 'text_delta', text: 'sorry, blocked' },
      { type: 'done', reason: 'stop' },
    ]);

    // 自定义 tool 用以判断 execute 是否被调用
    let executed = false;
    class TracedEchoTool implements ITool<{ text: string }, ToolResult> {
      readonly name = 'echo';
      readonly description = '';
      readonly parameters = { type: 'object', properties: {} };
      readonly safetyLevel = 'read_only' as const;
      async execute(): Promise<ToolResult> {
        executed = true;
        return { ok: true, content: 'should not run' };
      }
    }

    const registry = new ToolRegistry();
    registry.register(new TracedEchoTool());

    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'x',
      // 过滤器：拒绝所有工具
      toolFilter: () => false,
      onEvent: (e) => events.push(e),
    });

    await loop.send('call echo');

    // execute 必须未被调用
    expect(executed).toBe(false);

    // tool_exec_end(ok:false, errorCode=TOOL.EXEC.UNSAFE_BLOCKED)
    const execEnd = events.find((e) => e.type === 'tool_exec_end');
    expect(execEnd).toMatchObject({
      ok: false,
      name: 'echo',
      errorCode: ErrorCodes.TOOL_EXEC_UNSAFE_BLOCKED,
    });

    // 最终 completed
    expect(events[events.length - 1]).toMatchObject({ type: 'task_end', reason: 'completed' });
  });

  it('toolFilter: hides disallowed tool from provider schemas', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', reason: 'stop' },
    ]);

    const registry = new ToolRegistry();
    registry.register(new EchoTool());

    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'x',
      // 白名单：只保留不存在的 'allowed' 工具 → echo 被过滤掉
      toolFilter: (t) => t.name === 'allowed',
    });

    await loop.send('hi');

    // Provider 收到的 tools 应为 undefined（过滤后列表为空）
    expect(provider.calls[0].tools).toBeUndefined();
  });

  it('toolFilter: allowed tool still passes through and executes', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'tool_start', id: 'call_1', name: 'echo' },
      { type: 'tool_args_delta', id: 'call_1', partial: '{"text":"ok"}' },
      { type: 'tool_end', id: 'call_1' },
      { type: 'done', reason: 'tool_use' },
    ]);
    provider.push([
      { type: 'text_delta', text: 'done' },
      { type: 'done', reason: 'stop' },
    ]);

    const registry = new ToolRegistry();
    registry.register(new EchoTool());

    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'x',
      toolFilter: (t) => t.name === 'echo',
      onEvent: (e) => events.push(e),
    });

    await loop.send('go');

    const execEnd = events.find((e) => e.type === 'tool_exec_end');
    expect(execEnd).toMatchObject({ ok: true, name: 'echo' });
    // Provider 第一次调用时 tools 非空且含 echo
    const tools = provider.calls[0].tools ?? [];
    expect(tools.some((t) => t.function.name === 'echo')).toBe(true);
  });

  it('caps at max_turns to avoid infinite loop', async () => {
    const provider = new ScriptedProvider();
    // 每轮都请求工具调用 → TaskLoop 会一直循环
    for (let i = 0; i < 5; i++) {
      provider.push([
        { type: 'tool_start', id: `call_${i}`, name: 'echo' },
        { type: 'tool_args_delta', id: `call_${i}`, partial: '{"text":"x"}' },
        { type: 'tool_end', id: `call_${i}` },
        { type: 'done', reason: 'tool_use' },
      ]);
    }

    const registry = new ToolRegistry();
    registry.register(new EchoTool());

    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'x',
      maxTurns: 3,
      onEvent: (e) => events.push(e),
    });

    await loop.send('spam');

    const end = events[events.length - 1];
    expect(end).toMatchObject({
      type: 'task_end',
      reason: 'max_turns',
      errorCode: ErrorCodes.TASK_LOOP_INFINITE,
    });
  });

  // W8.3 · Context 压缩状态广播
  it('emits context_stats with level=none when budget sufficient', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', reason: 'stop' },
    ]);
    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'hi',
      onEvent: (e) => events.push(e),
      contextManager: new ContextManager({ contextWindow: 32_000 }),
    });

    await loop.send('short');

    const stats = events.find((e) => e.type === 'context_stats');
    expect(stats).toBeDefined();
    expect(stats).toMatchObject({
      type: 'context_stats',
      level: 'none',
    });
    // inputBudget = 32000 - 16384(outputReserve)
    expect((stats as { inputBudget: number }).inputBudget).toBe(32_000 - 16_384);
    expect((stats as { originalTokens: number }).originalTokens).toBeGreaterThan(0);
    expect((stats as { savingsPercent: number }).savingsPercent).toBe(0);
  });

  it('emits context_stats with higher level when budget tight', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', reason: 'stop' },
    ]);
    const events: TaskEvent[] = [];
    // 设小小窗口，强迫进入 light/medium/heavy
    const longUser = 'x'.repeat(8_000); // 约 2300 tokens
    const loop = new TaskLoop({
      provider,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'sys',
      onEvent: (e) => events.push(e),
      contextManager: new ContextManager({
        contextWindow: 2_000,
        outputReserve: 512,
        protectedTurns: 1,
      }),
    });

    await loop.send(longUser);

    const stats = events.find((e) => e.type === 'context_stats') as
      | { type: 'context_stats'; level: string; originalTokens: number; compressedTokens: number }
      | undefined;
    expect(stats).toBeDefined();
    expect(stats!.level).not.toBe('none');
    expect(stats!.compressedTokens).toBeLessThanOrEqual(stats!.originalTokens);
  });

  it('does not emit context_stats when contextManager omitted', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', reason: 'stop' },
    ]);
    const events: TaskEvent[] = [];
    const loop = new TaskLoop({
      provider,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'x',
      onEvent: (e) => events.push(e),
      // 不传 contextManager
    });

    await loop.send('hello');

    expect(events.find((e) => e.type === 'context_stats')).toBeUndefined();
  });
});

// ─────────── W15.5 · Auto-Thinking-Router：modelOverride 透传 ───────────

describe('TaskLoop · modelOverride 透传（W15.5）', () => {
  beforeEach(() => {
    initLogger({
      logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
      level: 'error',
      dev: false,
    });
  });

  it('modelOverride 已设置 → 每次 createMessage 都带 modelOverride', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', reason: 'stop' },
    ]);
    const loop = new TaskLoop({
      provider,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'x',
      modelOverride: 'deepseek-reasoner',
    });
    await loop.send('证明 1+1=2');
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].modelOverride).toBe('deepseek-reasoner');
  });

  it('modelOverride 未传 → createMessage 不含该字段', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'hi' },
      { type: 'done', reason: 'stop' },
    ]);
    const loop = new TaskLoop({
      provider,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'x',
    });
    await loop.send('hello');
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].modelOverride).toBeUndefined();
  });

  it('modelOverride 在多轮（工具调用后继续）全程保持', async () => {
    const provider = new ScriptedProvider();
    // 第 1 轮：tool_use
    provider.push([
      { type: 'tool_start', id: 'tc1', name: 'echo' },
      { type: 'tool_args_delta', id: 'tc1', partial: '{"text":"x"}' },
      { type: 'tool_end', id: 'tc1' },
      { type: 'done', reason: 'tool_use' },
    ]);
    // 第 2 轮：completed
    provider.push([
      { type: 'text_delta', text: 'done' },
      { type: 'done', reason: 'stop' },
    ]);
    const reg = new ToolRegistry();
    reg.register(new EchoTool());
    const loop = new TaskLoop({
      provider,
      toolRegistry: reg,
      systemPrompt: 'x',
      modelOverride: 'deepseek-reasoner',
    });
    await loop.send('分析死锁并逐步推导');
    expect(provider.calls.length).toBe(2);
    expect(provider.calls[0].modelOverride).toBe('deepseek-reasoner');
    expect(provider.calls[1].modelOverride).toBe('deepseek-reasoner');
  });
});
