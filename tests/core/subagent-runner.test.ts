/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * SubagentRunner 单测（W6.6 / W6.6b / W6.7）
 *
 * 覆盖：
 * - 参数校验（subagent_type / description / prompt / timeout）
 * - 工具白名单：非白名单工具对子代理不可见
 * - summary 提取：累积 text_delta 后 trim 返回
 * - completed 但 summary 为空 → SUBAGENT_FAILED
 * - 父 signal abort → SUBAGENT_INTERRUPTED_BY_RESTART
 * - timeout 触发 → SUBAGENT_INTERRUPTED_BY_RESTART
 * - provider error → SUBAGENT_FAILED
 * - max_turns → SUBAGENT_FAILED
 * - 自定义 systemPrompt 透传至 Provider
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { runSubagent } from '../../src/core/subagent/index.js';
import { ToolRegistry, type ITool, type ToolResult } from '../../src/core/tools/index.js';
import type { IProvider } from '../../src/providers/base.js';
import type {
  Capability,
  CreateMessageOptions,
  Pricing,
  ProbeResult,
  StreamEvent,
} from '../../src/providers/types.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import { initLogger } from '../../src/infra/logger.js';
import * as os from 'node:os';
import * as path from 'node:path';

// ─────────── Scripted Provider（复用 task-loop.test 范式） ───────────

class ScriptedProvider implements IProvider {
  readonly id = 'fake-subagent';
  readonly capabilities: readonly Capability[] = ['text', 'tool-use'];
  readonly contextWindow = 32_000;
  readonly pricing: Pricing = { inputPerMillion: 0, outputPerMillion: 0, currency: 'CNY' };

  private readonly scripts: StreamEvent[][] = [];
  public calls: CreateMessageOptions[] = [];

  push(events: StreamEvent[]): void {
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

class FakeReadFileTool implements ITool<{ path: string }, ToolResult> {
  readonly name = 'read_file';
  readonly description = 'fake';
  readonly parameters = { type: 'object', properties: {} };
  readonly safetyLevel = 'read_only' as const;
  async execute(): Promise<ToolResult> {
    return { ok: true, content: 'fake file content' };
  }
}

class FakeSearchWebTool implements ITool<Record<string, unknown>, ToolResult> {
  readonly name = 'search_web';
  readonly description = 'fake';
  readonly parameters = { type: 'object', properties: {} };
  readonly safetyLevel = 'network' as const;
  async execute(): Promise<ToolResult> {
    return { ok: true, content: 'search result' };
  }
}

class FakeBashTool implements ITool<Record<string, unknown>, ToolResult> {
  readonly name = 'bash';
  readonly description = 'fake';
  readonly parameters = { type: 'object', properties: {} };
  readonly safetyLevel = 'destructive' as const;
  async execute(): Promise<ToolResult> {
    return { ok: true, content: '' };
  }
}

class FakeGetTerminalOutputTool implements ITool<Record<string, unknown>, ToolResult> {
  readonly name = 'get_terminal_output';
  readonly description = 'fake';
  readonly parameters = { type: 'object', properties: {} };
  readonly safetyLevel = 'read_only' as const;
  async execute(): Promise<ToolResult> {
    return { ok: true, content: '' };
  }
}

beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
});

function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(new FakeReadFileTool());
  reg.register(new FakeSearchWebTool());
  reg.register(new FakeBashTool());
  reg.register(new FakeGetTerminalOutputTool());
  return reg;
}

// ─────────── 测试 ───────────

describe('runSubagent - validation', () => {
  it('rejects invalid subagent_type', async () => {
    const provider = new ScriptedProvider();
    await expect(
      runSubagent(
        { provider, toolRegistry: buildRegistry() },
        {
          invocation: {
            // @ts-expect-error intentional invalid
            subagent_type: 'NotExist',
            description: 'x',
            prompt: 'y',
          },
        },
      ),
    ).rejects.toMatchObject({
      code: ErrorCodes.SUBAGENT_INVOCATION_INVALID,
    });
  });

  it('rejects empty description', async () => {
    const provider = new ScriptedProvider();
    await expect(
      runSubagent(
        { provider, toolRegistry: buildRegistry() },
        {
          invocation: {
            subagent_type: 'Browser',
            description: '   ',
            prompt: 'y',
          },
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.SUBAGENT_INVOCATION_INVALID });
  });

  it('rejects empty prompt', async () => {
    const provider = new ScriptedProvider();
    await expect(
      runSubagent(
        { provider, toolRegistry: buildRegistry() },
        {
          invocation: {
            subagent_type: 'Browser',
            description: 'x',
            prompt: '',
          },
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.SUBAGENT_INVOCATION_INVALID });
  });

  it('rejects negative timeout', async () => {
    const provider = new ScriptedProvider();
    await expect(
      runSubagent(
        { provider, toolRegistry: buildRegistry() },
        {
          invocation: {
            subagent_type: 'Browser',
            description: 'x',
            prompt: 'y',
            timeout: -1,
          },
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.SUBAGENT_INVOCATION_INVALID });
  });
});

describe('runSubagent - tool filtering', () => {
  it('Browser subagent only sees whitelisted tools in provider call', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', reason: 'stop' },
    ]);

    const result = await runSubagent(
      { provider, toolRegistry: buildRegistry() },
      {
        invocation: {
          subagent_type: 'Browser',
          description: 'probe',
          prompt: 'do nothing',
        },
      },
    );

    expect(result.summary).toBe('ok');
    expect(provider.calls).toHaveLength(1);
    const tools = provider.calls[0].tools ?? [];
    const names = tools.map((t) => t.function.name);
    // 白名单内的工具可见
    expect(names).toContain('search_web');
    // read_file 不在 Browser 白名单 → 不可见
    expect(names).not.toContain('read_file');
    expect(names).not.toContain('Agent');
  });

  it('Guide subagent cannot see search_web / search_codebase', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'guide answer' },
      { type: 'done', reason: 'stop' },
    ]);

    await runSubagent(
      { provider, toolRegistry: buildRegistry() },
      {
        invocation: {
          subagent_type: 'Guide',
          description: 'help',
          prompt: 'how to configure',
        },
      },
    );

    const tools = provider.calls[0].tools ?? [];
    const names = tools.map((t) => t.function.name);
    expect(names).not.toContain('search_web');
    expect(names).not.toContain('search_codebase');
    // read_file 是 Guide 白名单允许的
    expect(names).toContain('read_file');
  });

  it('Verify subagent sees bash/get_terminal_output/read_file but not network tools', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: '✅ PASSED' },
      { type: 'done', reason: 'stop' },
    ]);

    await runSubagent(
      { provider, toolRegistry: buildRegistry() },
      {
        invocation: {
          subagent_type: 'Verify',
          description: 'verify',
          prompt: 'run tests',
        },
      },
    );

    const tools = provider.calls[0].tools ?? [];
    const names = tools.map((t) => t.function.name);
    expect(names).toContain('bash');
    expect(names).toContain('get_terminal_output');
    expect(names).toContain('read_file');
    // Verify 不含网络工具
    expect(names).not.toContain('search_web');
    expect(names).not.toContain('Agent');
  });
});

describe('runSubagent - system prompt', () => {
  it('uses subagent definition systemPrompt, not main-agent one', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'done' },
      { type: 'done', reason: 'stop' },
    ]);

    await runSubagent(
      { provider, toolRegistry: buildRegistry() },
      {
        invocation: {
          subagent_type: 'Research',
          description: 'dig',
          prompt: 'investigate X',
        },
      },
    );

    const msgs = provider.calls[0].messages;
    const sys = msgs.find((m) => m.role === 'system');
    expect(sys).toBeDefined();
    const sysContent = typeof sys?.content === 'string' ? sys.content : '';
    expect(sysContent).toMatch(/Research/);
    expect(sysContent).toMatch(/search_codebase/);
  });
});

describe('runSubagent - summary extraction', () => {
  it('concatenates text_delta and trims', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: '  Hello' },
      { type: 'text_delta', text: ' World  ' },
      { type: 'done', reason: 'stop' },
    ]);

    const result = await runSubagent(
      { provider, toolRegistry: buildRegistry() },
      {
        invocation: { subagent_type: 'Browser', description: 'x', prompt: 'y' },
      },
    );

    expect(result.summary).toBe('Hello World');
  });

  it('throws SUBAGENT_FAILED when completed with empty summary', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      // 只给 done，不发任何 text
      { type: 'done', reason: 'stop' },
    ]);

    await expect(
      runSubagent(
        { provider, toolRegistry: buildRegistry() },
        {
          invocation: { subagent_type: 'Browser', description: 'x', prompt: 'y' },
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.SUBAGENT_FAILED });
  });
});

describe('runSubagent - failure modes', () => {
  it('maps provider error to SUBAGENT_FAILED', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      {
        type: 'error',
        error: {
          code: ErrorCodes.PROVIDER_RATE_LIMITED,
          message: 'rate limited',
          retryable: false,
        },
      },
      { type: 'done', reason: 'error' },
    ]);

    await expect(
      runSubagent(
        { provider, toolRegistry: buildRegistry() },
        {
          invocation: { subagent_type: 'Browser', description: 'x', prompt: 'y' },
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.SUBAGENT_FAILED });
  });

  it('maps max_turns to SUBAGENT_FAILED', async () => {
    const provider = new ScriptedProvider();
    // 脚本上始终请求 tool_use，让 TaskLoop 达到 maxTurns
    // Browser.maxTurns = 15，推 20 份脚本让其耗尽
    for (let i = 0; i < 20; i++) {
      provider.push([
        { type: 'tool_start', id: `c${i}`, name: 'search_web' },
        { type: 'tool_args_delta', id: `c${i}`, partial: '{}' },
        { type: 'tool_end', id: `c${i}` },
        { type: 'done', reason: 'tool_use' },
      ]);
    }

    await expect(
      runSubagent(
        { provider, toolRegistry: buildRegistry() },
        {
          invocation: { subagent_type: 'Browser', description: 'x', prompt: 'y' },
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.SUBAGENT_FAILED });
  });
});

describe('runSubagent - cancellation & timeout', () => {
  it('parent signal abort → SUBAGENT_INTERRUPTED_BY_RESTART', async () => {
    // 构造一个永远不结束的 provider（等 signal）
    const provider: IProvider = {
      id: 'hang',
      capabilities: ['text'],
      contextWindow: 1000,
      pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'CNY' },
      countTokens: async () => 0,
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

    const parentAc = new AbortController();
    setTimeout(() => parentAc.abort(), 10);

    await expect(
      runSubagent(
        { provider, toolRegistry: buildRegistry() },
        {
          invocation: { subagent_type: 'Browser', description: 'x', prompt: 'y' },
          signal: parentAc.signal,
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.SUBAGENT_INTERRUPTED_BY_RESTART });
  });

  it('timeout triggers abort', async () => {
    const provider: IProvider = {
      id: 'hang3',
      capabilities: ['text'],
      contextWindow: 1000,
      pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'CNY' },
      countTokens: async () => 0,
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

    await expect(
      runSubagent(
        { provider, toolRegistry: buildRegistry() },
        {
          invocation: {
            subagent_type: 'Browser',
            description: 'x',
            prompt: 'y',
            timeout: 50,
          },
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.SUBAGENT_INTERRUPTED_BY_RESTART });
  });
});

describe('runSubagent - event forwarding', () => {
  it('invokes onEvent for text_delta + task_end', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'hi' },
      { type: 'done', reason: 'stop' },
    ]);

    const seen: string[] = [];
    await runSubagent(
      { provider, toolRegistry: buildRegistry() },
      {
        invocation: { subagent_type: 'Browser', description: 'x', prompt: 'y' },
        onEvent: (ev) => seen.push(ev.type),
      },
    );

    expect(seen).toContain('text_delta');
    expect(seen).toContain('task_end');
  });
});
