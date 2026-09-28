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
 * - max_turns → 降级回传部分成果（partial=true；有正文带正文，无正文给拆分建议）
 * - 自定义 systemPrompt 透传至 Provider
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { runSubagent } from '../../src/core/subagent/index.js';
import type { SubagentDefinition, SubagentRegistry } from '../../src/core/subagent/index.js';
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

  updateApiKey(): void {
    // no-op（IProvider 接口要求，测试无需轮换 Key）
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

/** 任意名字的假工具：用于验证 runner 硬拦截（写工具 / 派生工具 / 主会话状态工具） */
class FakeNamedTool implements ITool<Record<string, unknown>, ToolResult> {
  readonly description = 'fake';
  readonly parameters = { type: 'object', properties: {} };
  readonly safetyLevel = 'workspace_write' as const;
  constructor(readonly name: string) {}
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
            // 'NotExist' 在类型层合法（SubagentType 放宽为 string），运行时由 validateInvocation 拒绝
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

  it('硬不变量：def 白名单里就算列了写工具，子代理也拿不到（runner 对所有路径统一拦截）', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', reason: 'stop' },
    ]);

    // 模拟内置 def 误列 / 自定义 agent 声明写工具的场景（旧实现只在 '*' 分支过 blocked，可被绕）
    const rogueDef: SubagentDefinition = {
      type: 'RogueWriter',
      allowedTools: new Set<string>([
        'read_file', 'search_replace', 'write_file', 'append_file', 'delete_file',
        'Agent', 'todo_write',
      ]),
      systemPrompt: 'rogue',
      maxTurns: 5,
      isBuiltin: true,
    };
    const registry: SubagentRegistry = {
      resolve: (t: string) => (t === 'RogueWriter' ? rogueDef : undefined),
      list: () => [rogueDef],
    };

    const reg = new ToolRegistry();
    reg.register(new FakeNamedTool('read_file'));
    reg.register(new FakeNamedTool('search_replace'));
    reg.register(new FakeNamedTool('write_file'));
    reg.register(new FakeNamedTool('append_file'));
    reg.register(new FakeNamedTool('delete_file'));
    reg.register(new FakeNamedTool('Agent'));
    reg.register(new FakeNamedTool('todo_write'));

    await runSubagent(
      { provider, toolRegistry: reg, registry },
      { invocation: { subagent_type: 'RogueWriter', description: 'x', prompt: 'y' } },
    );

    const tools = provider.calls[0].tools ?? [];
    const names = tools.map((t) => t.function.name);
    // 白名单内的读工具可见
    expect(names).toContain('read_file');
    // 写工具 / 派生工具 / 主会话状态工具一律不可见
    expect(names).not.toContain('search_replace');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('append_file');
    expect(names).not.toContain('delete_file');
    expect(names).not.toContain('Agent');
    expect(names).not.toContain('todo_write');
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

  it('completed with empty summary → degrades to a non-empty note instead of throwing', async () => {
    const provider = new ScriptedProvider();
    provider.push([
      // 只给 done，不发任何 text
      { type: 'done', reason: 'stop' },
    ]);

    // 旧行为：空 summary 硬抛 SUBAGENT_FAILED。
    // 新行为：子代理正常结束但无正文时降级返回一段说明，不再让已完成的工作作废。
    const result = await runSubagent(
      { provider, toolRegistry: buildRegistry() },
      {
        invocation: { subagent_type: 'Browser', description: 'x', prompt: 'y' },
      },
    );

    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary).toMatch(/Browser/);
    expect(result.stats?.toolCalls).toBe(0);
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

  it('max_turns → 降级回传部分成果（partial=true），不再硬失败丢成果', async () => {
    const provider = new ScriptedProvider();
    // 脚本上始终请求 tool_use，让 TaskLoop 达到 maxTurns
    // Browser.maxTurns = 15，推 20 份脚本让其耗尽；第 14 轮带一段正文模拟"已产出的部分成果"
    for (let i = 0; i < 20; i++) {
      const evs: StreamEvent[] = [
        { type: 'tool_start', id: `c${i}`, name: 'search_web' },
        { type: 'tool_args_delta', id: `c${i}`, partial: '{}' },
        { type: 'tool_end', id: `c${i}` },
        { type: 'done', reason: 'tool_use' },
      ];
      if (i === 13) {
        evs.unshift({ type: 'text_delta', text: '部分调研结论 A' });
      }
      provider.push(evs);
    }

    const r = await runSubagent(
      { provider, toolRegistry: buildRegistry() },
      {
        invocation: { subagent_type: 'Browser', description: 'x', prompt: 'y' },
      },
    );

    expect(r.partial).toBe(true);
    expect(r.summary).toContain('达到轮次上限');
    expect(r.summary).toContain('部分调研结论 A');
    expect(r.stats?.toolCalls).toBeGreaterThan(0);
  });

  it('max_turns 且无正文 → 降级 summary 提示拆分任务（含工具调用数）', async () => {
    const provider = new ScriptedProvider();
    for (let i = 0; i < 20; i++) {
      provider.push([
        { type: 'tool_start', id: `c${i}`, name: 'search_web' },
        { type: 'tool_args_delta', id: `c${i}`, partial: '{}' },
        { type: 'tool_end', id: `c${i}` },
        { type: 'done', reason: 'tool_use' },
      ]);
    }

    const r = await runSubagent(
      { provider, toolRegistry: buildRegistry() },
      {
        invocation: { subagent_type: 'Browser', description: 'x', prompt: 'y' },
      },
    );

    expect(r.partial).toBe(true);
    expect(r.summary).toContain('未输出文本总结');
    expect(r.summary).toContain('拆分');
    expect(r.stats?.toolCalls).toBeGreaterThan(0);
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

  it('角色级超时：invocation 未给 timeout 时用 def.timeoutMs（修复「长任务被 120s 默认值杀死」）', async () => {
    const provider: IProvider = {
      id: 'hang-def-timeout',
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

    // def 级预算 50ms；修复前会回退到 120s 默认值（测试超时失败）
    const fastDef: SubagentDefinition = {
      type: 'FastTimeout',
      allowedTools: new Set<string>(['read_file']),
      systemPrompt: 'x',
      maxTurns: 5,
      timeoutMs: 50,
      isBuiltin: true,
    };
    const registry: SubagentRegistry = {
      resolve: (t: string) => (t === 'FastTimeout' ? fastDef : undefined),
      list: () => [fastDef],
    };

    await expect(
      runSubagent(
        { provider, toolRegistry: buildRegistry(), registry },
        { invocation: { subagent_type: 'FastTimeout', description: 'x', prompt: 'y' } },
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
