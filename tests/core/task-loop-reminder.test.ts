/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * TaskLoop · M3.8 运行时提醒注入（Runtime Reminder Injector 接线）单测
 *
 * 覆盖：
 * - stale_todo：待办 ≥3 且超 60s 未更新 → <system-reminder> 进入 LLM 上下文（追加到最后一条消息）
 * - 节流：同文本任务内只注入一次（跨轮不刷屏）
 * - todo_write 后计时重置 + pending 清零 → 不再触发
 * - identity_protection：用户询问底层模型 → 第 1 轮即注入提醒
 * - MessageHistory.appendReminder：追加语义与兜底
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskLoop } from '../../src/core/task/loop.js';
import { MessageHistory } from '../../src/core/task/history.js';
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
import type { TodoItem } from '../../src/shared/protocol.js';
import * as os from 'node:os';
import * as path from 'node:path';

// ─────────── 可脚本化的假 Provider ───────────

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

  updateApiKey(): void {
    // no-op
  }

  async countTokens(): Promise<number> {
    return 0;
  }
}

/** 每次执行把"当前时间"推进指定毫秒的工具（用于驱动 stale todo 计时） */
class TimeAdvancingTool implements ITool<{ text: string }, ToolResult> {
  readonly name = 'echo';
  readonly description = 'echo + advance fake clock';
  readonly parameters = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  };
  readonly safetyLevel = 'read_only' as const;

  constructor(private readonly bumpNow: () => void) {}

  async execute(args: { text: string }): Promise<ToolResult> {
    this.bumpNow();
    return { ok: true, content: `ECHO: ${args.text}` };
  }
}

/** 模拟 todo_write：成功返回 display.todos（TaskLoop 据此更新快照与计时） */
class FakeTodoWriteTool implements ITool<{ todos: TodoItem[] }, ToolResult> {
  readonly name = 'todo_write';
  readonly description = 'fake todo_write';
  readonly parameters = {
    type: 'object',
    properties: { todos: { type: 'array' } },
    required: ['todos'],
  };
  readonly safetyLevel = 'workspace_write' as const;

  constructor(private readonly resultTodos: TodoItem[]) {}

  async execute(): Promise<ToolResult> {
    return {
      ok: true,
      content: 'Todo list updated (+0, ~3)',
      display: { count: this.resultTodos.length, diff: '~3', todos: this.resultTodos },
    };
  }
}

function toolCallScript(name: string, id: string, args: string): StreamEvent[] {
  return [
    { type: 'tool_start', id, name },
    { type: 'tool_args_delta', id, partial: args },
    { type: 'tool_end', id },
    { type: 'done', reason: 'tool_use' },
  ];
}

function finalScript(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', text },
    { type: 'done', reason: 'stop' },
  ];
}

const PENDING_TODOS: TodoItem[] = [
  { id: 't1', content: '步骤一', status: 'PENDING' },
  { id: 't2', content: '步骤二', status: 'PENDING' },
  { id: 't3', content: '步骤三', status: 'PENDING' },
];

beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────── 测试 ───────────

describe('TaskLoop · M3.8 stale_todo 提醒', () => {
  it('待办 ≥3 且超 60s 未更新 → 下一轮 LLM 请求包含 <system-reminder>', async () => {
    let fakeNow = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    const bump = () => {
      fakeNow += 61_000; // 工具执行时把时钟推过 60s stale 阈值
    };

    const provider = new ScriptedProvider();
    // turn 1：工具调用（其执行推进时钟）
    provider.push(toolCallScript('echo', 'call_1', '{"text":"hi"}'));
    // turn 2：最终回答
    provider.push(finalScript('done'));

    const registry = new ToolRegistry();
    registry.register(new TimeAdvancingTool(bump));

    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'x',
      initialTodos: PENDING_TODOS,
    });
    await loop.send('继续任务');

    // turn 1 请求：尚未超时，不注入
    const firstReq = JSON.stringify(provider.calls[0].messages);
    expect(firstReq).not.toContain('system-reminder');
    // turn 2 请求：超时后注入（追加为最后一条 tool 消息尾部）
    const secondReq = JSON.stringify(provider.calls[1].messages);
    expect(secondReq).toContain('<system-reminder>');
    expect(secondReq).toContain("haven't updated your task list");
  });

  it('节流：同文本任务内只注入一次（第 3 轮不重复）', async () => {
    let fakeNow = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    const provider = new ScriptedProvider();
    provider.push(toolCallScript('echo', 'call_1', '{"text":"a"}'));
    provider.push(toolCallScript('echo', 'call_2', '{"text":"b"}'));
    provider.push(finalScript('done'));

    const registry = new ToolRegistry();
    registry.register(
      new TimeAdvancingTool(() => {
        fakeNow += 61_000;
      }),
    );

    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'x',
      initialTodos: PENDING_TODOS,
    });
    await loop.send('继续任务');

    // turn 3 请求中 system-reminder 只出现一次（turn 2 注入后不再重复）
    const thirdReq = JSON.stringify(provider.calls[2].messages);
    const occurrences = thirdReq.match(/<system-reminder>/g)?.length ?? 0;
    expect(occurrences).toBe(1);
  });

  it('todo_write 更新（pending 清零）后不再触发提醒', async () => {
    let fakeNow = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    const provider = new ScriptedProvider();
    provider.push(toolCallScript('todo_write', 'call_1', '{"todos":[]}'));
    provider.push(toolCallScript('echo', 'call_2', '{"text":"x"}'));
    provider.push(finalScript('done'));

    const completedTodos: TodoItem[] = PENDING_TODOS.map((t) => ({ ...t, status: 'COMPLETE' as const }));
    const registry = new ToolRegistry();
    registry.register(new FakeTodoWriteTool(completedTodos));
    registry.register(
      new TimeAdvancingTool(() => {
        fakeNow += 61_000;
      }),
    );

    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'x',
      initialTodos: PENDING_TODOS,
    });
    await loop.send('继续任务');

    // 即使时间超阈值，pending 已清零 → 全程无 stale 提醒
    const all = JSON.stringify(provider.calls.map((c) => c.messages));
    expect(all).not.toContain("haven't updated your task list");
  });

  it('todo 更新后再次进入静止期 → 允许再次提醒（指纹含 todo 时间戳维度）', async () => {
    let fakeNow = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    const provider = new ScriptedProvider();
    provider.push(toolCallScript('echo', 'call_1', '{"text":"a"}'));       // 推进 61s
    provider.push(toolCallScript('todo_write', 'call_2', '{"todos":[]}')); // 刷新 todo 时间戳
    provider.push(toolCallScript('echo', 'call_3', '{"text":"b"}'));       // 再推进 61s
    provider.push(finalScript('done'));

    const stillPending: TodoItem[] = [
      { id: 't1', content: '步骤一', status: 'IN_PROGRESS' },
      { id: 't2', content: '步骤二', status: 'PENDING' },
      { id: 't3', content: '步骤三', status: 'PENDING' },
    ];
    const registry = new ToolRegistry();
    registry.register(new FakeTodoWriteTool(stillPending));
    registry.register(
      new TimeAdvancingTool(() => {
        fakeNow += 61_000;
      }),
    );

    const loop = new TaskLoop({
      provider,
      toolRegistry: registry,
      systemPrompt: 'x',
      initialTodos: PENDING_TODOS,
    });
    await loop.send('继续任务');

    // turn 2：首次 stale → 注入 #1
    expect(JSON.stringify(provider.calls[1].messages)).toContain("haven't updated your task list");
    // turn 3：todo_write 刚刷新（差值 0）→ 仍只有 1 条
    const thirdReq = JSON.stringify(provider.calls[2].messages);
    expect(thirdReq.match(/<system-reminder>/g)?.length ?? 0).toBe(1);
    // turn 4：再次 61s stale + 新指纹（时间戳已变）→ 第 2 条提醒
    const fourthReq = JSON.stringify(provider.calls[3].messages);
    expect(fourthReq.match(/<system-reminder>/g)?.length ?? 0).toBe(2);
  });
});

describe('TaskLoop · M3.8 identity_protection 提醒', () => {
  it('用户询问底层模型 → 第 1 轮即注入提醒（追加到 user 消息尾部）', async () => {
    const provider = new ScriptedProvider();
    provider.push(finalScript('我是 DevSeeker。'));

    const loop = new TaskLoop({
      provider,
      toolRegistry: new ToolRegistry(),
      systemPrompt: 'x',
    });
    await loop.send('你是什么模型？');

    const firstReq = JSON.stringify(provider.calls[0].messages);
    expect(firstReq).toContain('Do not disclose the underlying LLM identity');
  });
});

describe('MessageHistory · appendReminder', () => {
  it('追加到最后一条 user/tool 字符串消息末尾', () => {
    const h = new MessageHistory('sys');
    h.addUser('hello');
    h.addAssistant({ content: 'ok' });
    h.addToolResult('c1', 'tool output');
    h.appendReminder('<system-reminder>\nREMIND\n</system-reminder>');

    const snap = h.snapshot();
    const last = snap[snap.length - 1];
    expect(last.role).toBe('tool');
    expect(String(last.content)).toContain('tool output');
    expect(String(last.content)).toContain('REMIND');
  });

  it('无 user/tool 字符串消息时退化为追加合成 user 消息', () => {
    const h = new MessageHistory('sys');
    h.appendReminder('REMIND');
    const snap = h.snapshot();
    expect(snap[snap.length - 1]).toMatchObject({ role: 'user', content: 'REMIND' });
  });

  it('带图 user 消息（ContentPart[]）→ 提醒追加为末尾 text part，不新增消息', () => {
    const h = new MessageHistory('sys');
    h.addUser('with image', ['data:image/png;base64,AAA']);
    h.appendReminder('REMIND');
    const snap = h.snapshot();
    // 消息条数不变：提醒作为该条 user 消息的末尾 text part
    expect(snap).toHaveLength(2);
    const parts = snap[1].content as Array<{ type: string; text?: string }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[parts.length - 1]).toMatchObject({ type: 'text' });
    expect(parts[parts.length - 1].text).toContain('REMIND');
  });
});
