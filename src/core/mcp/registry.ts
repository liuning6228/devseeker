/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * MCP Registry — 多 server 生命周期 + 重连 + 工具灰化（W9.8）
 *
 * 职责：
 * - 持有所有配置中的 MCP server，每个 server 独立管理：
 *   state: 'idle' → 'connecting' → 'ready' | 'failed' | 'disabled(grayed)'
 * - start(): 并行启动所有（非 disabled 的）server，执行 MCP 握手 + tools/list
 * - 重连：transport close 触发重连，指数回退（1s/2s/4s/8s/16s），累计失败 N 次后灰化
 * - 灰化：工具仍在 tool registry 中（保持 LLM prompt 稳定），但 execute 时返回错误
 * - stop(): 并行关闭所有 client
 *
 * 注入：
 * - transportFactory(serverCfg) → ITransport   （测试可注入 InMemoryTransport）
 * - clientFactory(transport)    → McpClient    （测试可注入假实现）
 * - sleep(ms)                                   （测试可替换 fake timer）
 */

import type { ITool } from '../tools/types.js';
import type { McpClient, McpClientOptions } from './client.js';
import type { ITransport } from './transport.js';
import { StdioTransport } from './stdio-transport.js';
import { McpClient as RealMcpClient } from './client.js';
import type { McpServerConfig } from './config.js';
import type { McpToolDefinition } from './protocol.js';
import { McpToolAdapter } from './tool-adapter.js';

export type McpServerState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'failed'
  | 'disabled';

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  toolCount: number;
  failureCount: number;
  lastError?: string;
  disabledReason?: string;
}

export interface McpRegistryOptions {
  /** 单次重连指数基数（ms），默认 1000 */
  reconnectBaseMs?: number;
  /** 累计失败 N 次后灰化，默认 3 */
  grayOutAfterFailures?: number;
  /** 注入 transport（测试用） */
  transportFactory?: (cfg: McpServerConfig) => ITransport;
  /** 注入 client（测试用） */
  clientFactory?: (transport: ITransport, opts: McpClientOptions) => McpClient;
  /** 注入 sleep（测试用） */
  sleep?: (ms: number) => Promise<void>;
  /** 注入 client 默认 options */
  clientOptions?: McpClientOptions;
}

interface ServerRuntime {
  cfg: McpServerConfig;
  state: McpServerState;
  failureCount: number;
  lastError?: string;
  disabledReason?: string;
  client?: McpClient;
  transport?: ITransport;
  tools: McpToolDefinition[];
  /** 是否在 shutdown 中（阻止再发起重连） */
  stopping: boolean;
}

export class McpRegistry {
  private readonly runtimes = new Map<string, ServerRuntime>();
  private readonly opts: Required<Omit<McpRegistryOptions, 'clientOptions'>> & {
    clientOptions: McpClientOptions;
  };

  constructor(opts: McpRegistryOptions = {}) {
    this.opts = {
      reconnectBaseMs: opts.reconnectBaseMs ?? 1000,
      grayOutAfterFailures: opts.grayOutAfterFailures ?? 3,
      transportFactory:
        opts.transportFactory ??
        ((cfg: McpServerConfig) =>
          new StdioTransport({
            command: cfg.command ?? '',
            args: cfg.args ?? [],
            env: cfg.env,
            cwd: cfg.cwd,
          })),
      clientFactory:
        opts.clientFactory ??
        ((t: ITransport, o: McpClientOptions) => new RealMcpClient(t, o)),
      sleep:
        opts.sleep ??
        ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.())),
      clientOptions: opts.clientOptions ?? {},
    };
  }

  /** 启动所有服务器：并行初始化，成功者 tools 可用 */
  async start(configs: McpServerConfig[]): Promise<void> {
    this.runtimes.clear();
    for (const cfg of configs) {
      this.runtimes.set(cfg.name, {
        cfg,
        state: cfg.disabled ? 'disabled' : 'idle',
        failureCount: 0,
        tools: [],
        stopping: false,
        disabledReason: cfg.disabled ? 'disabled in mcp.json' : undefined,
      });
    }
    const tasks: Promise<void>[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.state === 'disabled') continue;
      tasks.push(this.connectServer(rt));
    }
    await Promise.all(tasks);
  }

  /** 返回所有 server 当前状态快照 */
  getStatuses(): McpServerStatus[] {
    return Array.from(this.runtimes.values()).map((rt) => ({
      name: rt.cfg.name,
      state: rt.state,
      toolCount: rt.tools.length,
      failureCount: rt.failureCount,
      lastError: rt.lastError,
      disabledReason: rt.disabledReason,
    }));
  }

  /**
   * 列出所有工具适配器（包括灰化状态的 tools，保持 LLM prompt 稳定）。
   * 灰化的 server → tools 仍在，但 execute 时会返回 errorCode。
   */
  listTools(): ITool[] {
    const out: ITool[] = [];
    for (const rt of this.runtimes.values()) {
      for (const def of rt.tools) {
        out.push(
          new McpToolAdapter({
            serverAlias: rt.cfg.name,
            toolDef: def,
            getClient: () => rt.client,
            isDisabled: () => rt.state === 'disabled' || rt.state === 'failed',
          }),
        );
      }
    }
    return out;
  }

  /** 关闭所有 server */
  async stop(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const rt of this.runtimes.values()) {
      rt.stopping = true;
      const client = rt.client;
      if (client) tasks.push(client.close('registry shutdown').catch(() => undefined));
    }
    await Promise.all(tasks);
    this.runtimes.clear();
  }

  /** 手动重启某个 server（用户点 UI） */
  async restart(name: string): Promise<boolean> {
    const rt = this.runtimes.get(name);
    if (!rt) return false;
    rt.stopping = false;
    if (rt.client) {
      try {
        await rt.client.close('manual restart');
      } catch {
        /* ignore */
      }
    }
    rt.client = undefined;
    rt.transport = undefined;
    rt.tools = [];
    rt.failureCount = 0;
    rt.lastError = undefined;
    rt.disabledReason = undefined;
    rt.state = 'idle';
    await this.connectServer(rt);
    return (rt.state as McpServerState) === 'ready';
  }

  // ───────────── internal ─────────────

  private async connectServer(rt: ServerRuntime): Promise<void> {
    if (rt.stopping) return;
    rt.state = 'connecting';
    rt.lastError = undefined;
    const transport = this.opts.transportFactory(rt.cfg);
    const client = this.opts.clientFactory(transport, this.opts.clientOptions);
    rt.transport = transport;
    rt.client = client;

    // 绑定 close 处理：若未在 stopping，则触发重连
    transport.onClose((reason) => {
      if (rt.stopping) return;
      if (rt.state === 'ready') {
        // 本连接断开，调度重连
        rt.state = 'failed';
        rt.lastError = reason ?? 'transport closed';
        void this.scheduleReconnect(rt);
      }
    });

    try {
      await client.initialize();
      const tools = await client.listTools();
      rt.tools = tools;
      rt.state = 'ready';
      rt.failureCount = 0;
    } catch (e) {
      const err = e as Error;
      rt.lastError = err.message;
      rt.failureCount += 1;
      if (rt.failureCount >= this.opts.grayOutAfterFailures) {
        rt.state = 'disabled';
        rt.disabledReason = `grayed out after ${rt.failureCount} consecutive failures`;
      } else {
        rt.state = 'failed';
        void this.scheduleReconnect(rt);
      }
      // 清理半连接
      try {
        await client.close('init failed');
      } catch {
        /* ignore */
      }
      rt.client = undefined;
      rt.transport = undefined;
    }
  }

  private async scheduleReconnect(rt: ServerRuntime): Promise<void> {
    if (rt.stopping) return;
    if (rt.state === 'disabled') return;
    const attempt = Math.min(rt.failureCount, 5);
    const delay = this.opts.reconnectBaseMs * Math.pow(2, Math.max(0, attempt - 1));
    await this.opts.sleep(delay);
    if (rt.stopping) return;
    if ((rt.state as McpServerState) === 'disabled') return;
    await this.connectServer(rt);
  }
}
