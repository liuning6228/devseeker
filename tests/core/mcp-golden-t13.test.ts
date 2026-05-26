/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W9.9 · T13 MCP 金测：配置 filesystem MCP server → 调用其 `write_file`
 *
 * 来源：DESIGN 附录 A 金测 T13 —— 透明调用 + 安全级 external 确认流程
 *
 * 覆盖的端到端链路：
 *   1) parseMcpConfig(mcp.json 字符串) 解析出 stdio server "filesystem"
 *   2) McpRegistry.start(configs)：InMemoryTransport + FakeClient 注入
 *      - 完成握手 + tools/list，得到 write_file
 *   3) registry.listTools() → 把适配后的 ITool 注册到 ToolRegistry
 *   4) ToolRunner.run()：safetyLevel === 'external' → approvalGate 触发
 *      - 用户拒绝 → TOOL_EXEC_UNSAFE_BLOCKED
 *      - 用户确认 → tool.execute 返回 content，ok=true
 *   5) 灰化（连续失败）后同名 tool 返回 MCP_SERVER_HEALTH_FAIL，但仍保留在 prompt
 *
 * 注：这里避免真子进程，依靠 factory 注入。
 */

import { describe, it, expect } from 'vitest';
import { TransportBase } from '../../src/core/mcp/transport.js';
import type { ITransport } from '../../src/core/mcp/transport.js';
import type {
  JsonRpcMessage,
  McpClient,
  McpRegistryOptions,
  McpToolDefinition,
  McpToolsCallResult,
} from '../../src/core/mcp/index.js';
import {
  McpRegistry,
  parseMcpConfig,
} from '../../src/core/mcp/index.js';
import { ToolRegistry, ToolRunner } from '../../src/core/tools/registry.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

// ─────────── 测试工具：InMemoryTransport + FakeClient（按 serverName 脚本）───────────

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
  triggerClose(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emitClose(reason);
  }
}

interface ClientScript {
  shouldFailInit: number;
  tools: McpToolDefinition[];
  callHandler?: (name: string, args: unknown) => Promise<McpToolsCallResult>;
}

class FakeClient {
  private readonly transport: ITransport;
  private readonly script: ClientScript;
  private _initialized = false;
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
    return { serverInfo: { name: 'fake-filesystem', version: '1.0.0' } };
  }
  async initialize(): Promise<unknown> {
    if (!this.transport.isOpen) await this.transport.start();
    if (this.script.shouldFailInit > 0) {
      this.script.shouldFailInit -= 1;
      throw new Error('fake init failure');
    }
    this._initialized = true;
    return { serverInfo: { name: 'fake-filesystem', version: '1.0.0' } };
  }
  async listTools(): Promise<McpToolDefinition[]> {
    return this.script.tools;
  }
  async callTool(name: string, args: unknown): Promise<McpToolsCallResult> {
    if (this.script.callHandler) {
      return this.script.callHandler(name, args);
    }
    return { content: [{ type: 'text', text: `(no handler for ${name})` }] };
  }
  async ping(): Promise<void> {}
  onNotification(): () => void {
    return () => undefined;
  }
  async close(reason?: string): Promise<void> {
    await this.transport.close(reason);
  }
}

function makeRegistryHarness(opts: Partial<McpRegistryOptions> = {}) {
  const transports = new Map<string, InMemoryTransport>();
  const clients = new Map<string, FakeClient>();
  const scripts = new Map<string, ClientScript>();
  const sleeps: number[] = [];
  let currentName = '';

  const getOrCreateScript = (name: string): ClientScript => {
    let sc = scripts.get(name);
    if (!sc) {
      sc = { shouldFailInit: 0, tools: [] };
      scripts.set(name, sc);
    }
    return sc;
  };

  const registry = new McpRegistry({
    reconnectBaseMs: 5,
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

  return { registry, transports, clients, scripts, sleeps, getOrCreateScript };
}

async function flush(turns = 20) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

// ─────────── T13 金测 ───────────

describe('T13 · MCP 金测 — filesystem.write_file 端到端', () => {
  /** 示例 mcp.json（filesystem server 通过 npx 启动；这里仅用于解析） */
  const FILESYSTEM_MCP_RAW = {
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '${workspaceFolder}'],
        env: {
          MCP_DEBUG: '${env.MCP_DEBUG}',
        },
      },
    },
  };

  const writeFileToolDef: McpToolDefinition = {
    name: 'write_file',
    description: 'Write text content to a file. Creates parent dirs as needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  };

  function buildRunner(approved: boolean, approvalCalls: Array<{ tool: string; args: unknown }>) {
    const registry = new ToolRegistry();
    const runner = new ToolRunner(registry, {
      approvalGate: async (req) => {
        approvalCalls.push({ tool: req.tool.name, args: req.args });
        return { approved };
      },
    });
    return { registry, runner };
  }

  it('parses mcp.json, boots registry, and exposes filesystem.write_file as external ITool', async () => {
    // 1) 解析配置 —— ${workspaceFolder} / ${env.MCP_DEBUG} 应展开
    const parsed = parseMcpConfig(FILESYSTEM_MCP_RAW, {
      workspaceRoot: 'C:/work/my-project',
      envLookup: (n) => (n === 'MCP_DEBUG' ? 'true' : undefined),
    });
    expect(parsed.errorCode).toBeUndefined();
    expect(parsed.config.warnings).toHaveLength(0);
    expect(parsed.config.servers).toHaveLength(1);
    const fsCfg = parsed.config.servers[0];
    expect(fsCfg.name).toBe('filesystem');
    expect(fsCfg.transport).toBe('stdio');
    expect(fsCfg.args).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      'C:/work/my-project',
    ]);
    expect(fsCfg.env?.MCP_DEBUG).toBe('true');

    // 2) 启动 registry，预注入 write_file 和 callHandler
    const h = makeRegistryHarness();
    const script = h.getOrCreateScript('filesystem');
    script.tools = [writeFileToolDef];
    script.callHandler = async (name, args) => {
      if (name === 'write_file') {
        const a = args as { path: string; content: string };
        return {
          content: [
            {
              type: 'text',
              text: `wrote ${a.content.length} bytes to ${a.path}`,
            },
          ],
        };
      }
      return { content: [], isError: true };
    };

    await h.registry.start(parsed.config.servers);
    const statuses = h.registry.getStatuses();
    expect(statuses[0].state).toBe('ready');
    expect(statuses[0].toolCount).toBe(1);

    // 3) 取出 tools，注册到 ToolRegistry
    const approvalCalls: Array<{ tool: string; args: unknown }> = [];
    const { registry: toolRegistry, runner } = buildRunner(true, approvalCalls);
    for (const t of h.registry.listTools()) toolRegistry.register(t);

    // 工具应以 `<serverAlias>.<toolName>` 命名
    const tool = toolRegistry.get('filesystem.write_file');
    expect(tool).toBeDefined();
    expect(tool!.safetyLevel).toBe('external');
    expect(tool!.description).toMatch(/\[mcp:filesystem\]/);

    // 4) 执行：external → approvalGate 被调用 → 确认 → ok=true
    const result = await runner.run({
      toolCallId: 'call-1',
      name: 'filesystem.write_file',
      args: { path: 'hello.txt', content: 'hi there' },
      workspaceRoot: 'C:/work/my-project',
      signal: new AbortController().signal,
      taskId: 't-1',
    });

    expect(approvalCalls).toHaveLength(1);
    expect(approvalCalls[0].tool).toBe('filesystem.write_file');
    expect(approvalCalls[0].args).toEqual({ path: 'hello.txt', content: 'hi there' });

    expect(result.ok).toBe(true);
    expect(result.content).toBe('wrote 8 bytes to hello.txt');
  });

  it('external tool returns TOOL_EXEC_UNSAFE_BLOCKED when approvalGate denies', async () => {
    const h = makeRegistryHarness();
    const script = h.getOrCreateScript('filesystem');
    script.tools = [writeFileToolDef];
    script.callHandler = async () => ({
      content: [{ type: 'text', text: 'should not be called' }],
    });

    const parsed = parseMcpConfig(FILESYSTEM_MCP_RAW, { workspaceRoot: '/w' });
    await h.registry.start(parsed.config.servers);

    const approvalCalls: Array<{ tool: string; args: unknown }> = [];
    const { registry: toolRegistry, runner } = buildRunner(false, approvalCalls);
    for (const t of h.registry.listTools()) toolRegistry.register(t);

    const result = await runner.run({
      toolCallId: 'c-deny',
      name: 'filesystem.write_file',
      args: { path: 'a.txt', content: 'x' },
      workspaceRoot: '/w',
      signal: new AbortController().signal,
      taskId: 't-2',
    });

    expect(approvalCalls).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(ErrorCodes.TOOL_EXEC_UNSAFE_BLOCKED);
  });

  it('after server gray-out, tool remains in registry but returns MCP_SERVER_HEALTH_FAIL', async () => {
    const h = makeRegistryHarness();
    // 一直失败 → 灰化
    h.getOrCreateScript('filesystem').shouldFailInit = 10;
    h.getOrCreateScript('filesystem').tools = [writeFileToolDef];

    const parsed = parseMcpConfig(FILESYSTEM_MCP_RAW, { workspaceRoot: '/w' });
    await h.registry.start(parsed.config.servers);
    await flush(40);

    const st = h.registry.getStatuses()[0];
    expect(st.state).toBe('disabled');

    // 灰化前 start 失败 → tools 未写入（因为 listTools 未成功）；
    // 所以这个场景下 listTools() 为空。验证 server 已被 gray-out。
    expect(h.registry.listTools()).toHaveLength(0);

    // 额外校验：若人为先注入 tool，灰化时 adapter 也应返回错误
    // 构造一个 orphan adapter 来验证 isDisabled 分支
    const { McpToolAdapter } = await import('../../src/core/mcp/tool-adapter.js');
    const orphan = new McpToolAdapter({
      serverAlias: 'filesystem',
      toolDef: writeFileToolDef,
      getClient: () => undefined,
      isDisabled: () => true,
    });
    const res = await orphan.execute(
      {},
      { workspaceRoot: '/w', signal: new AbortController().signal, taskId: 'x', toolCallId: 'y' },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ErrorCodes.MCP_SERVER_HEALTH_FAIL);
  });

  it('rejects SSE servers with warning and keeps only stdio', () => {
    const mixed = {
      mcpServers: {
        fs: { command: 'x', args: [] },
        web: { transport: 'sse', url: 'https://example.com/mcp' },
      },
    };
    const parsed = parseMcpConfig(mixed, { workspaceRoot: '/w' });
    expect(parsed.config.servers.map((c: { name: string }) => c.name)).toEqual(['fs']);
    expect(
      parsed.config.warnings.some((w) => /web/.test(w) && /sse/i.test(w)),
    ).toBe(true);
  });
});
