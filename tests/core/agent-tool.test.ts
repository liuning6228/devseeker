/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * AgentTool 单测（W6.7）
 *
 * 覆盖：
 * - 参数校验：subagent_type / description / prompt
 * - getRunnerDeps 闭包被每次调用时调用
 * - 成功路径：把 summary 包成 <subagent_result> XML
 * - 失败路径：runSubagent 抛错 → ok:false + errorCode
 * - safetyLevel = network
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentTool } from '../../src/core/tools/index.js';
import type { ToolContext } from '../../src/core/tools/index.js';
import { ToolRegistry, type ITool, type ToolResult } from '../../src/core/tools/index.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import type { IProvider } from '../../src/providers/base.js';
import type {
  Capability,
  CreateMessageOptions,
  Pricing,
  ProbeResult,
  StreamEvent,
} from '../../src/providers/types.js';
import type { SubagentRunnerDeps } from '../../src/core/subagent/index.js';
import type { TaskEvent } from '../../src/shared/protocol.js';
import { initLogger } from '../../src/infra/logger.js';
import * as os from 'node:os';
import * as path from 'node:path';

class ScriptedProvider implements IProvider {
  readonly id = 'fake-agent-tool';
  readonly capabilities: readonly Capability[] = ['text', 'tool-use'];
  readonly contextWindow = 32_000;
  readonly pricing: Pricing = { inputPerMillion: 0, outputPerMillion: 0, currency: 'CNY' };
  private readonly scripts: StreamEvent[][] = [];
  push(events: StreamEvent[]): void {
    this.scripts.push(events);
  }
  createMessage(_opts: CreateMessageOptions): AsyncIterable<StreamEvent> {
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
  updateApiKey(): void {
    // no-op（IProvider 接口要求，测试无需轮换 Key）
  }
}

class FakeReadFileTool implements ITool<Record<string, unknown>, ToolResult> {
  readonly name = 'read_file';
  readonly description = 'fake';
  readonly parameters = { type: 'object', properties: {} };
  readonly safetyLevel = 'read_only' as const;
  async execute(): Promise<ToolResult> {
    return { ok: true, content: '' };
  }
}

function buildDeps(provider: IProvider): SubagentRunnerDeps {
  const registry = new ToolRegistry();
  registry.register(new FakeReadFileTool());
  return { provider, toolRegistry: registry };
}

function buildCtx(): ToolContext {
  return {
    workspaceRoot: undefined,
    signal: new AbortController().signal,
    taskId: 't',
    toolCallId: 'c1',
  };
}

beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
});

describe('AgentTool - metadata', () => {
  it('name=Agent, safetyLevel=network', () => {
    const tool = new AgentTool({ getRunnerDeps: () => buildDeps(new ScriptedProvider()) });
    expect(tool.name).toBe('Agent');
    expect(tool.safetyLevel).toBe('network');
    expect(typeof tool.description).toBe('string');
    const schema = tool.parameters as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toEqual(expect.arrayContaining(['subagent_type', 'description', 'prompt']));
    expect(schema.properties).toHaveProperty('subagent_type');
    expect(schema.properties).toHaveProperty('timeout');
  });
});

describe('AgentTool - arg validation', () => {
  const deps = { getRunnerDeps: () => buildDeps(new ScriptedProvider()) };
  const tool = new AgentTool(deps);

  it('rejects non-object args', async () => {
    // @ts-expect-error intentional bad input
    const res = await tool.execute(null, buildCtx());
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects invalid subagent_type', async () => {
    const res = await tool.execute(
      { subagent_type: 'UnknownOne', description: 'x', prompt: 'y' },
      buildCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.SUBAGENT_INVOCATION_INVALID);
  });

  it('rejects empty description', async () => {
    const res = await tool.execute(
      { subagent_type: 'Browser', description: '   ', prompt: 'y' },
      buildCtx(),
    );
    expect(res.ok).toBe(false);
    // AgentTool 在参数校验阶段就拒绝了，返回 TOOL_ARGS_INVALID
    expect(res.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects empty prompt', async () => {
    const res = await tool.execute(
      { subagent_type: 'Browser', description: 'x', prompt: '   ' },
      buildCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });
});

describe('AgentTool - deps closure', () => {
  it('calls getRunnerDeps exactly once per execute', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'done' },
      { type: 'done', reason: 'stop' },
    ]);
    let calls = 0;
    const tool = new AgentTool({
      getRunnerDeps: () => {
        calls += 1;
        return buildDeps(provider);
      },
    });

    await tool.execute(
      { subagent_type: 'Browser', description: 'probe', prompt: 'hi' },
      buildCtx(),
    );

    expect(calls).toBe(1);
  });

  it('reports SUBAGENT_FAILED when getRunnerDeps throws', async () => {
    const tool = new AgentTool({
      getRunnerDeps: () => {
        throw new Error('no provider');
      },
    });
    const res = await tool.execute(
      { subagent_type: 'Browser', description: 'x', prompt: 'y' },
      buildCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.SUBAGENT_FAILED);
    expect(res.content).toMatch(/no provider/);
  });
});

describe('AgentTool - success path', () => {
  it('wraps summary in <subagent_result> tag', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'Summary text.' },
      { type: 'done', reason: 'stop' },
    ]);
    const tool = new AgentTool({ getRunnerDeps: () => buildDeps(provider) });

    const res = await tool.execute(
      { subagent_type: 'Research', description: 'dig', prompt: 'look into X' },
      buildCtx(),
    );

    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/^<subagent_result type="Research" description="dig">/);
    expect(res.content).toMatch(/Summary text\./);
    expect(res.content).toMatch(/<\/subagent_result>/);
    expect(res.content).toMatch(/子代理回报/);

    // display 信息
    expect(res.display).toMatchObject({
      subagentType: 'Research',
      description: 'dig',
    });
    expect(res.display?.summaryPreview).toBe('Summary text.');
  });

  it('escapes quotes in description attribute', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', reason: 'stop' },
    ]);
    const tool = new AgentTool({ getRunnerDeps: () => buildDeps(provider) });

    const res = await tool.execute(
      { subagent_type: 'Browser', description: 'has "quote" & <tag>', prompt: 'p' },
      buildCtx(),
    );

    expect(res.ok).toBe(true);
    // " → &quot; / < → &lt; / > → &gt;
    expect(res.content).toContain('&quot;');
    expect(res.content).toContain('&lt;tag&gt;');
    expect(res.content).not.toMatch(/description="[^"]*"[^>]*"/); // 没有未转义的第二个 "
  });
});

describe('AgentTool - failure path', () => {
  it('maps runSubagent failure to ok:false', async () => {
    const provider = new ScriptedProvider();
    // 子代理 Provider 报不可重试错误 → runSubagent 抛 SUBAGENT_FAILED
    // （空文本 done 现在会降级为非空说明并返回 ok:true，不再算失败）
    provider.push([
      {
        type: 'error',
        error: { code: ErrorCodes.PROVIDER_RATE_LIMITED, message: 'rate limited', retryable: false },
      },
      { type: 'done', reason: 'error' },
    ]);
    const tool = new AgentTool({ getRunnerDeps: () => buildDeps(provider) });

    const res = await tool.execute(
      { subagent_type: 'Browser', description: 'x', prompt: 'y' },
      buildCtx(),
    );

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.SUBAGENT_FAILED);
    expect(res.content).toMatch(/子代理 Browser/);
  });

  it('completed with empty summary → ok:true with degraded note', async () => {
    const provider = new ScriptedProvider();
    provider.push([{ type: 'done', reason: 'stop' }]);
    const tool = new AgentTool({ getRunnerDeps: () => buildDeps(provider) });

    const res = await tool.execute(
      { subagent_type: 'Browser', description: 'x', prompt: 'y' },
      buildCtx(),
    );

    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/Browser/);
  });

  it('aborted via ctx.signal → ok:false with interrupted code', async () => {
    const provider: IProvider = {
      id: 'hang',
      capabilities: ['text'],
      contextWindow: 1000,
      pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'CNY' },
      countTokens: async () => 0,
      updateApiKey: () => {},
      probe: async () => ({ ok: true, latencyMs: 0 }),
      createMessage: ({ signal }) =>
        (async function* (): AsyncGenerator<StreamEvent> {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          yield { type: 'done', reason: 'aborted' };
        })(),
    };

    const registry = new ToolRegistry();
    registry.register(new FakeReadFileTool());
    const tool = new AgentTool({
      getRunnerDeps: () => ({ provider, toolRegistry: registry }),
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const ctx: ToolContext = {
      workspaceRoot: undefined,
      signal: ac.signal,
      taskId: 't',
      toolCallId: 'c',
    };

    const res = await tool.execute(
      { subagent_type: 'Browser', description: 'x', prompt: 'y' },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.SUBAGENT_INTERRUPTED_BY_RESTART);
  });
});

describe('AgentTool - subagent event bridge (P0)', () => {
  it('ctx.emitChildEvent 收到 subagent_start → subagent_end，parentToolCallId 正确归位', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: '调查结论' },
      { type: 'done', reason: 'stop' },
    ]);
    const tool = new AgentTool({ getRunnerDeps: () => buildDeps(provider) });
    const events: TaskEvent[] = [];
    const ctx: ToolContext = {
      ...buildCtx(),
      toolCallId: 'call-bridge-1',
      emitChildEvent: (ev) => events.push(ev),
    };

    const res = await tool.execute(
      { subagent_type: 'Browser', description: '调查 X', prompt: 'y' },
      ctx,
    );

    expect(res.ok).toBe(true);
    type SubagentTaskEvent = Extract<TaskEvent, { type: 'subagent_event' }>;
    const subEvents = events.filter((e): e is SubagentTaskEvent => e.type === 'subagent_event');
    const progress = subEvents.map((e) => e.progress);

    // 首帧：卡片进入 running 态，且能按 parentToolCallId 归位
    expect(subEvents[0]).toMatchObject({
      type: 'subagent_event',
      parentToolCallId: 'call-bridge-1',
      agentType: 'Browser',
    });
    expect(progress[0]).toMatchObject({
      type: 'subagent_start',
      agentType: 'Browser',
      description: '调查 X',
    });
    // 文本合并 + 终态（真实 summary）
    expect(progress).toContainEqual({ type: 'subagent_text', text: '调查结论' });
    expect(progress[progress.length - 1]).toMatchObject({
      type: 'subagent_end',
      ok: true,
      summary: '调查结论',
      toolCalls: 0,
    });
  });

  it('无 emitChildEvent（无 UI 通道）时不报错，返回值与旧版一致', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', reason: 'stop' },
    ]);
    const tool = new AgentTool({ getRunnerDeps: () => buildDeps(provider) });

    const res = await tool.execute(
      { subagent_type: 'Browser', description: 'x', prompt: 'y' },
      buildCtx(),
    );

    expect(res.ok).toBe(true);
    expect(res.content).toContain('ok');
  });
});

describe('AgentTool - 后台子代理结果回流（结果契约闭环）', () => {
  it('background 完成 → 摘要经 ctx.injectContext 注入主 loop 上下文', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: '后台调研结论' },
      { type: 'done', reason: 'stop' },
    ]);
    const tool = new AgentTool({ getRunnerDeps: () => buildDeps(provider) });
    const notes: string[] = [];
    const ctx: ToolContext = {
      ...buildCtx(),
      toolCallId: 'c-bg-1',
      injectContext: (text) => notes.push(text),
    };

    const res = await tool.execute(
      { subagent_type: 'Browser', description: '后台调研', prompt: 'y', background: true },
      ctx,
    );
    expect(res.ok).toBe(true);

    // 等后台 runFn 完成（脚本 provider 需若干微任务）
    await new Promise((r) => setTimeout(r, 50));

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('<background_subagent_result');
    expect(notes[0]).toContain('后台调研结论');
    expect(notes[0]).toContain('agent_id="bg_');
  });

  it('前台（非 background）结果作为工具返回值，不注入上下文', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', reason: 'stop' },
    ]);
    const tool = new AgentTool({ getRunnerDeps: () => buildDeps(provider) });
    const notes: string[] = [];
    const ctx: ToolContext = {
      ...buildCtx(),
      toolCallId: 'c-fg-1',
      injectContext: (t) => notes.push(t),
    };

    const res = await tool.execute(
      { subagent_type: 'Browser', description: 'x', prompt: 'y' },
      ctx,
    );

    expect(res.ok).toBe(true);
    expect(notes).toHaveLength(0);
    expect(res.content).toContain('ok');
  });
});
