/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W9.5 · MCP protocol + transport + client 测试
 *
 * 不启动真子进程；使用 InMemoryTransport 模拟双向消息流。
 */

import { describe, it, expect } from 'vitest';
import {
  LineFramer,
  TransportBase,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  MCP_METHOD,
  MCP_PROTOCOL_VERSION,
  McpClient,
} from '../../src/core/mcp/index.js';

/** 刷几轮 microtask，让 McpClient 内部 async 链推进到下一步。 */
async function flush(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

// ─────────── JSON-RPC type guards ───────────

describe('JSON-RPC type guards', () => {
  it('recognizes request vs notification vs response', () => {
    const req: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'x' };
    const notif: JsonRpcMessage = { jsonrpc: '2.0', method: 'n' };
    const resp: JsonRpcMessage = { jsonrpc: '2.0', id: 1, result: {} };
    const errResp: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -1, message: 'x' },
    } as unknown as JsonRpcMessage;
    expect(isJsonRpcRequest(req)).toBe(true);
    expect(isJsonRpcNotification(notif)).toBe(true);
    expect(isJsonRpcResponse(resp)).toBe(true);
    expect(isJsonRpcResponse(errResp)).toBe(true);
    expect(isJsonRpcNotification(req)).toBe(false);
  });
});

// ─────────── LineFramer ───────────

describe('LineFramer', () => {
  it('parses a single complete line', () => {
    const f = new LineFramer();
    const msgs = f.push('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as JsonRpcResponse).id).toBe(1);
  });

  it('buffers incomplete line across chunks', () => {
    const f = new LineFramer();
    expect(f.push('{"jsonr')).toHaveLength(0);
    expect(f.push('pc":"2.0","id":2,"result":null}\n')).toHaveLength(1);
  });

  it('handles CRLF and multiple messages in one chunk', () => {
    const f = new LineFramer();
    const raw =
      '{"jsonrpc":"2.0","id":1,"result":{}}\r\n{"jsonrpc":"2.0","method":"n"}\n';
    const msgs = f.push(raw);
    expect(msgs).toHaveLength(2);
  });

  it('skips blank lines', () => {
    const f = new LineFramer();
    const msgs = f.push('\n\n{"jsonrpc":"2.0","id":1,"result":1}\n\n');
    expect(msgs).toHaveLength(1);
  });

  it('reports parse errors via injected callback and keeps buffer clean', () => {
    const errs: string[] = [];
    const f = new LineFramer((line, _err) => errs.push(line));
    const msgs = f.push('not-json\n{"jsonrpc":"2.0","id":1,"result":1}\n');
    expect(errs).toEqual(['not-json']);
    expect(msgs).toHaveLength(1);
  });
});

// ─────────── InMemoryTransport (test helper) ───────────

class InMemoryTransport extends TransportBase {
  public sent: JsonRpcMessage[] = [];
  async start(): Promise<void> {
    this.started = true;
  }
  async send(msg: JsonRpcMessage): Promise<void> {
    this.sent.push(msg);
  }
  async close(reason?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emitClose(reason);
  }
  /** 辅助：模拟 server 回推一条消息 */
  inject(m: JsonRpcMessage): void {
    this.emitMessage(m);
  }
  /** 辅助：模拟 transport 错误 */
  injectError(msg: string): void {
    this.emitError(new Error(msg));
  }
}

// ─────────── McpClient ───────────

describe('McpClient', () => {
  it('initialize sends request and sends initialized notification on response', async () => {
    const t = new InMemoryTransport();
    const c = new McpClient(t);

    const p = c.initialize();
    // 等一个 microtask 让 send() 先入队
    await Promise.resolve();
    expect(t.sent).toHaveLength(1);
    const req = t.sent[0] as JsonRpcRequest;
    expect(req.method).toBe(MCP_METHOD.INITIALIZE);
    expect((req.params as any).protocolVersion).toBe(MCP_PROTOCOL_VERSION);

    // 模拟 server 响应
    t.inject({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'mock', version: '0.0.1' },
      },
    });

    const initRes = await p;
    expect(initRes.serverInfo.name).toBe('mock');
    expect(c.isInitialized).toBe(true);

    // 验证 initialized notification 已发送
    expect(t.sent.length).toBe(2);
    expect((t.sent[1] as JsonRpcNotification).method).toBe(MCP_METHOD.INITIALIZED);
  });

  it('listTools returns aggregated tools with pagination', async () => {
    const t = new InMemoryTransport();
    const c = new McpClient(t);
    // fast-path: mark initialized manually via handshake
    const initP = c.initialize();
    await Promise.resolve();
    t.inject({
      jsonrpc: '2.0',
      id: (t.sent[0] as JsonRpcRequest).id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        serverInfo: { name: 's', version: '1' },
      },
    });
    await initP;

    const listP = c.listTools();
    await flush();
    // First tools/list
    const first = t.sent[t.sent.length - 1] as JsonRpcRequest;
    expect(first.method).toBe(MCP_METHOD.TOOLS_LIST);
    t.inject({
      jsonrpc: '2.0',
      id: first.id,
      result: { tools: [{ name: 'a' }], nextCursor: 'c1' },
    });
    await flush();
    const second = t.sent[t.sent.length - 1] as JsonRpcRequest;
    expect(second.method).toBe(MCP_METHOD.TOOLS_LIST);
    expect((second.params as any).cursor).toBe('c1');
    t.inject({
      jsonrpc: '2.0',
      id: second.id,
      result: { tools: [{ name: 'b' }] },
    });
    const tools = await listP;
    expect(tools.map((x) => x.name)).toEqual(['a', 'b']);
  });

  it('callTool rejects with error response', async () => {
    const t = new InMemoryTransport();
    const c = new McpClient(t);
    const initP = c.initialize();
    await Promise.resolve();
    t.inject({
      jsonrpc: '2.0',
      id: (t.sent[0] as JsonRpcRequest).id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        serverInfo: { name: 's', version: '1' },
      },
    });
    await initP;

    const callP = c.callTool('broken', { x: 1 });
    await flush();
    const req = t.sent[t.sent.length - 1] as JsonRpcRequest;
    t.inject({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32000, message: 'tool failed' },
    } as JsonRpcMessage);
    await expect(callP).rejects.toMatchObject({ message: 'tool failed' });
  });

  it('transport close rejects pending requests', async () => {
    const t = new InMemoryTransport();
    const c = new McpClient(t);
    const initP = c.initialize();
    await Promise.resolve();
    await t.close('bye');
    await expect(initP).rejects.toThrow(/transport closed|bye/);
  });

  it('throws if callTool invoked before initialize', async () => {
    const t = new InMemoryTransport();
    const c = new McpClient(t);
    await expect(c.callTool('x')).rejects.toThrow(/not initialized/);
  });

  it('delivers server notifications to subscribers', async () => {
    const t = new InMemoryTransport();
    const c = new McpClient(t);
    const got: string[] = [];
    c.onNotification((n) => got.push(n.method));
    const initP = c.initialize();
    await Promise.resolve();
    // 先 inject 一个 notification（握手中也允许）
    t.inject({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    t.inject({
      jsonrpc: '2.0',
      id: (t.sent[0] as JsonRpcRequest).id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        serverInfo: { name: 's', version: '1' },
      },
    });
    await initP;
    expect(got).toContain('notifications/tools/list_changed');
  });

  it('request times out when no response arrives', async () => {
    const t = new InMemoryTransport();
    let scheduled: (() => void) | undefined;
    const c = new McpClient(t, {
      requestTimeoutMs: 50,
      setTimeoutImpl: (fn) => {
        scheduled = fn;
        return 'h';
      },
      clearTimeoutImpl: () => {
        scheduled = undefined;
      },
    });
    const p = c.initialize();
    await Promise.resolve();
    expect(scheduled).toBeTypeOf('function');
    scheduled!(); // 手动触发超时
    await expect(p).rejects.toThrow(/timeout/);
  });
});
