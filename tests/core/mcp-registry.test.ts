/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W9.8 · MCP Registry 重连 + 灰化 + tool list 测试
 *
 * 用 InMemoryTransport + FakeClient 注入，避免真子进程。
 * scripts Map 按 server name 持久化，重连后新建的 FakeClient 仍读取同一脚本，
 * 可模拟连续失败→灰化、失败一次后重连成功 等多种场景。
 */

import { describe, it, expect } from 'vitest';
import { TransportBase } from '../../src/core/mcp/transport.js';
import type { ITransport } from '../../src/core/mcp/transport.js';
import type {
  JsonRpcMessage,
  McpClient,
  McpRegistryOptions,
  McpServerConfig,
  McpToolDefinition,
} from '../../src/core/mcp/index.js';
import { McpRegistry } from '../../src/core/mcp/index.js';

// Scripted fake transport — 只提供 isOpen/close 钩子
class InMemoryTransport extends TransportBase {
  public sent: JsonRpcMessage[] = [];
  async start(): Promise<void> {
    this.started = true;
  }
  async send(m: JsonRpcMessage): Promise<void> {
    this.sent.push(m);
  }
  async close(reason?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emitClose(reason);
  }
  emit(m: JsonRpcMessage): void {
    this.emitMessage(m);
  }
  triggerClose(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emitClose(reason);
  }
}

interface ClientScript {
  shouldFailInit: number; // 下几次 initialize 抛错
  toolsScript: McpToolDefinition[][]; // 每次 listTools 弹出一组
}

/** 可控 FakeClient：从共享 script 读取，重连后新实例仍沿用 */
class FakeClient {
  private readonly transport: ITransport;
  private readonly script: ClientScript;
  private _initialized = false;
  private _meta: unknown;
  public initTimes = 0;
  public closed = false;

  constructor(transport: ITransport, script: ClientScript) {
    this.transport = transport;
    this.script = script;
    transport.onClose(() => {
      this._initialized = false;
    });
  }

  get isInitialized(): boolean {
    return this._initialized;
  }
  get serverMetadata(): unknown {
    return this._meta;
  }

  async initialize(): Promise<unknown> {
    this.initTimes += 1;
    if (!this.transport.isOpen) await this.transport.start();
    if (this.script.shouldFailInit > 0) {
      this.script.shouldFailInit -= 1;
      throw new Error('fake init failure');
    }
    this._initialized = true;
    this._meta = { serverInfo: { name: 'fake', version: '1' } };
    return this._meta;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    // 首个脚本出队；若只剩一条则保留作为默认后续值
    if (this.script.toolsScript.length > 1) {
      return this.script.toolsScript.shift() ?? [];
    }
    return this.script.toolsScript[0] ?? [];
  }

  async callTool(): Promise<unknown> {
    return { content: [] };
  }

  async ping(): Promise<void> {}

  onNotification(): () => void {
    return () => undefined;
  }

  async close(reason?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.transport.close(reason);
  }
}

function makeRegistry(opts: Partial<McpRegistryOptions> = {}) {
  const transports = new Map<string, InMemoryTransport>();
  const clients = new Map<string, FakeClient>();
  const sleeps: number[] = [];
  const scripts = new Map<string, ClientScript>();
  let currentName = '';

  const getOrCreateScript = (name: string): ClientScript => {
    let sc = scripts.get(name);
    if (!sc) {
      sc = { shouldFailInit: 0, toolsScript: [[]] };
      scripts.set(name, sc);
    }
    return sc;
  };

  const registry = new McpRegistry({
    reconnectBaseMs: 10,
    grayOutAfterFailures: 3,
    transportFactory: (cfg) => {
      currentName = cfg.name;
      const t = new InMemoryTransport();
      transports.set(cfg.name, t);
      return t;
    },
    clientFactory: (transport) => {
      const name = currentName;
      const sc = getOrCreateScript(name);
      const c = new FakeClient(transport, sc);
      clients.set(name, c);
      return c as unknown as McpClient;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...opts,
  });

  return { registry, transports, clients, sleeps, scripts, getOrCreateScript };
}

async function flushMicrotasks(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

describe('McpRegistry', () => {
  it('connects and lists tools for a ready server', async () => {
    const { registry, getOrCreateScript } = makeRegistry();
    getOrCreateScript('fs').toolsScript = [[{ name: 'read' }, { name: 'write' }]];

    await registry.start([{ name: 'fs', transport: 'stdio', command: 'x' }]);

    const statuses = registry.getStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].state).toBe('ready');
    expect(statuses[0].toolCount).toBe(2);

    const tools = registry.listTools();
    expect(tools.map((t) => t.name)).toEqual(['fs.read', 'fs.write']);
  });

  it('disabled servers are not connected', async () => {
    const { registry, clients } = makeRegistry();
    await registry.start([
      { name: 'a', transport: 'stdio', command: 'x', disabled: true },
    ]);
    expect(clients.size).toBe(0);
    expect(registry.getStatuses()[0].state).toBe('disabled');
  });

  it('grays out a server after N consecutive init failures', async () => {
    const { registry, sleeps, getOrCreateScript } = makeRegistry();
    // 预置脚本：一直失败（10 次窗口充分）
    getOrCreateScript('bad').shouldFailInit = 10;

    await registry.start([{ name: 'bad', transport: 'stdio', command: 'x' }]);
    // 第一次失败已计入；scheduleReconnect 靠 sleep() resolve 推进
    // 需等 microtask 多轮消化至 failureCount >= 3
    await flushMicrotasks(40);

    const st = registry.getStatuses()[0];
    expect(st.state).toBe('disabled');
    expect(st.failureCount).toBeGreaterThanOrEqual(3);
    expect(st.disabledReason).toMatch(/grayed out/i);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('tools of grayed-out server return errorCode on execute', async () => {
    const { registry, getOrCreateScript } = makeRegistry();
    getOrCreateScript('x').toolsScript = [[{ name: 'foo' }]];
    await registry.start([{ name: 'x', transport: 'stdio', command: 'x' }]);

    const tools = registry.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('x.foo');
    expect(tools[0].safetyLevel).toBe('external');
  });

  it('reconnect after transport close restores ready state', async () => {
    const { registry, transports, getOrCreateScript } = makeRegistry();
    // 脚本保留一个"稳定"的 tool 列表，重连后仍返回
    getOrCreateScript('s').toolsScript = [[{ name: 't1' }]];
    await registry.start([{ name: 's', transport: 'stdio', command: 'x' }]);
    expect(registry.getStatuses()[0].state).toBe('ready');

    // 模拟 transport 断开
    const t = transports.get('s')!;
    t.triggerClose('simulated crash');
    // 等几轮 microtask：scheduleReconnect → sleep resolve → connectServer
    await flushMicrotasks(20);

    const st = registry.getStatuses()[0];
    expect(st.state).toBe('ready');
    expect(st.failureCount).toBe(0);
  });

  it('stop closes all clients and clears runtimes', async () => {
    const { registry } = makeRegistry();
    await registry.start([{ name: 's', transport: 'stdio', command: 'x' }]);
    await registry.stop();
    expect(registry.getStatuses()).toHaveLength(0);
  });

  it('restart resets a failed server', async () => {
    const { registry, getOrCreateScript } = makeRegistry();
    // 脚本：第一次失败，之后成功
    getOrCreateScript('s').shouldFailInit = 1;
    await registry.start([{ name: 's', transport: 'stdio', command: 'x' }]);
    await flushMicrotasks(20);

    // restart 后应能成功连上
    const ok = await registry.restart('s');
    expect(ok).toBe(true);
    expect(registry.getStatuses()[0].state).toBe('ready');
  });
});
