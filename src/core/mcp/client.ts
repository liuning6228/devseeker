/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * MCP Client — JSON-RPC client with initialize → tools/list → tools/call
 *
 * W9.5 · §M14.4
 *
 * 语义：
 * - 通过 ITransport 收发 JSON-RPC 2.0 消息
 * - 维护 pending request map（id → { resolve/reject/timeoutHandle }）
 * - 提供高级 API：initialize / listTools / callTool / ping / close
 * - request timeout 默认 15s；可注入 setTimeout/clearTimeout 供测试使用
 * - 并发请求通过独立 id 复用同一连接
 */

import { ErrorCodes } from '../errors/index.js';
import {
  MCP_METHOD,
  MCP_PROTOCOL_VERSION,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type McpInitializeParams,
  type McpInitializeResult,
  type McpToolDefinition,
  type McpToolsCallResult,
  type McpToolsListResult,
  isJsonRpcNotification,
  isJsonRpcResponse,
} from './protocol.js';
import type { ITransport } from './transport.js';

export interface McpClientOptions {
  /** 请求超时（ms），默认 15000 */
  requestTimeoutMs?: number;
  /** 客户端声明的版本 */
  clientInfo?: { name: string; version: string };
  /** 可注入 setTimeout/clearTimeout，测试用 */
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  /** 可注入 id 生成器，测试用 */
  nextId?: () => number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error & { code?: string; mcpError?: JsonRpcError['error'] }) => void;
  timeoutHandle: unknown;
  method: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class McpClient {
  private readonly transport: ITransport;
  private readonly opts: McpClientOptions;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private idCounter = 0;
  private readonly notificationListeners = new Set<(n: JsonRpcNotification) => void>();
  private startedHandshake = false;
  private initialized = false;
  private serverInfo?: McpInitializeResult;

  constructor(transport: ITransport, opts: McpClientOptions = {}) {
    this.transport = transport;
    this.opts = opts;
    this.transport.onMessage((m) => this.onMessage(m));
    this.transport.onError((err) => {
      // 将 transport error 广播给所有 pending request
      for (const [id, p] of this.pending) {
        this.clearPending(id);
        p.reject(wrap(ErrorCodes.MCP_SERVER_HEALTH_FAIL, err.message));
      }
    });
    this.transport.onClose((reason) => {
      for (const [id, p] of this.pending) {
        this.clearPending(id);
        p.reject(
          wrap(ErrorCodes.MCP_SERVER_HEALTH_FAIL, `transport closed: ${reason ?? 'unknown'}`),
        );
      }
    });
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get serverMetadata(): McpInitializeResult | undefined {
    return this.serverInfo;
  }

  /** 启动 transport 并执行 MCP 握手：initialize + notifications/initialized */
  async initialize(): Promise<McpInitializeResult> {
    if (this.startedHandshake) {
      if (this.initialized && this.serverInfo) return this.serverInfo;
      throw wrap(ErrorCodes.MCP_PROTOCOL_VIOLATION, 'initialize already in progress');
    }
    this.startedHandshake = true;
    if (!this.transport.isOpen) {
      await this.transport.start();
    }
    const params: McpInitializeParams = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: this.opts.clientInfo ?? { name: 'devseeker', version: '0.1.0' },
    };
    const result = await this.request<McpInitializeResult>(MCP_METHOD.INITIALIZE, params);
    this.serverInfo = result;
    this.initialized = true;
    // 握手完成通知
    await this.notify(MCP_METHOD.INITIALIZED, {});
    return result;
  }

  /** 列出所有工具（可翻页） */
  async listTools(cursor?: string): Promise<McpToolDefinition[]> {
    this.assertInitialized();
    const tools: McpToolDefinition[] = [];
    let next = cursor;
    let guard = 0;
    do {
      const res = await this.request<McpToolsListResult>(MCP_METHOD.TOOLS_LIST, next ? { cursor: next } : {});
      if (Array.isArray(res?.tools)) tools.push(...res.tools);
      next = res?.nextCursor;
      if (++guard > 50) break; // 防止死循环
    } while (next);
    return tools;
  }

  /** 调用一个工具，返回内容数组 */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<McpToolsCallResult> {
    this.assertInitialized();
    return this.request<McpToolsCallResult>(MCP_METHOD.TOOLS_CALL, { name, arguments: args });
  }

  /** ping（可选 health check） */
  async ping(): Promise<void> {
    await this.request(MCP_METHOD.PING, {});
  }

  /** 订阅 notifications（例如 tools/listChanged） */
  onNotification(h: (n: JsonRpcNotification) => void): () => void {
    this.notificationListeners.add(h);
    return () => this.notificationListeners.delete(h);
  }

  /** 关闭：清空 pending + 关 transport */
  async close(reason?: string): Promise<void> {
    for (const [id, p] of this.pending) {
      this.clearPending(id);
      p.reject(wrap(ErrorCodes.MCP_SERVER_HEALTH_FAIL, `client closing: ${reason ?? 'shutdown'}`));
    }
    await this.transport.close(reason);
    this.initialized = false;
  }

  // ───────────── internals ─────────────

  private nextIdValue(): number {
    if (this.opts.nextId) return this.opts.nextId();
    this.idCounter += 1;
    return this.idCounter;
  }

  private setTimeoutFn(fn: () => void, ms: number): unknown {
    if (this.opts.setTimeoutImpl) return this.opts.setTimeoutImpl(fn, ms);
    const h = setTimeout(fn, ms);
    (h as unknown as { unref?: () => void }).unref?.();
    return h;
  }

  private clearTimeoutFn(handle: unknown): void {
    if (this.opts.clearTimeoutImpl) return this.opts.clearTimeoutImpl(handle);
    clearTimeout(handle as NodeJS.Timeout);
  }

  private clearPending(id: JsonRpcId): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.clearTimeoutFn(p.timeoutHandle);
    this.pending.delete(id);
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw wrap(ErrorCodes.MCP_PROTOCOL_VIOLATION, 'MCP client not initialized; call initialize() first');
    }
  }

  private async request<R>(method: string, params: unknown): Promise<R> {
    if (!this.transport.isOpen) {
      throw wrap(ErrorCodes.MCP_SERVER_HEALTH_FAIL, 'transport not open');
    }
    const id = this.nextIdValue();
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    const p = new Promise<R>((resolve, reject) => {
      const timeoutHandle = this.setTimeoutFn(() => {
        this.pending.delete(id);
        reject(
          wrap(
            ErrorCodes.MCP_SERVER_HEALTH_FAIL,
            `MCP request timeout after ${timeoutMs}ms: ${method}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        method,
        timeoutHandle,
        resolve: (v) => resolve(v as R),
        reject,
      });
    });
    try {
      await this.transport.send(req);
    } catch (e) {
      this.clearPending(id);
      throw wrap(ErrorCodes.MCP_SERVER_HEALTH_FAIL, `send failed: ${String(e)}`);
    }
    return p;
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const n: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    await this.transport.send(n);
  }

  private onMessage(m: JsonRpcMessage): void {
    if (isJsonRpcNotification(m)) {
      for (const h of this.notificationListeners) {
        try {
          h(m);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (isJsonRpcResponse(m)) {
      const resp = m as JsonRpcResponse;
      const id = (resp as JsonRpcSuccess).id;
      const pending = this.pending.get(id);
      if (!pending) return; // 未知响应：忽略
      this.clearPending(id);
      if ('error' in resp) {
        const err = wrap(ErrorCodes.MCP_TOOL_CALL_FAIL, resp.error.message);
        err.mcpError = resp.error;
        pending.reject(err);
      } else {
        pending.resolve(resp.result);
      }
      return;
    }
    // 服务器发来请求？MCP 里极少（例如 sampling），暂忽略
  }
}

// ───────────── helpers ─────────────

function wrap(code: string, message: string): Error & { code: string; mcpError?: JsonRpcError['error'] } {
  const err = new Error(message) as Error & { code: string; mcpError?: JsonRpcError['error'] };
  err.code = code;
  return err;
}
