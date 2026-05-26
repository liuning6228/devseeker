/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * MCP Transport — 抽象层
 *
 * W9.5 · 支持 stdio / SSE（本轮仅 stdio 实装；SSE 预留接口）
 *
 * 合约：
 * - start() 启动连接并开始读入；实现方需在有消息时调用 emit()
 * - send(msg) 单条 JSON-RPC message 出站
 * - close() 关闭并释放资源；幂等
 * - onMessage / onError / onClose 订阅
 */

import type { JsonRpcMessage } from './protocol.js';

export type TransportMessageHandler = (msg: JsonRpcMessage) => void;
export type TransportErrorHandler = (err: Error) => void;
export type TransportCloseHandler = (reason?: string) => void;

export interface ITransport {
  /** 启动连接（幂等：多次调用只首次生效） */
  start(): Promise<void>;
  /** 发送单条消息 */
  send(msg: JsonRpcMessage): Promise<void>;
  /** 关闭连接 */
  close(reason?: string): Promise<void>;
  onMessage(h: TransportMessageHandler): void;
  onError(h: TransportErrorHandler): void;
  onClose(h: TransportCloseHandler): void;
  /** 是否已启动并未关闭 */
  readonly isOpen: boolean;
}

export abstract class TransportBase implements ITransport {
  protected started = false;
  protected closed = false;
  protected msgHandlers: TransportMessageHandler[] = [];
  protected errHandlers: TransportErrorHandler[] = [];
  protected closeHandlers: TransportCloseHandler[] = [];

  abstract start(): Promise<void>;
  abstract send(msg: JsonRpcMessage): Promise<void>;
  abstract close(reason?: string): Promise<void>;

  get isOpen(): boolean {
    return this.started && !this.closed;
  }

  onMessage(h: TransportMessageHandler): void {
    this.msgHandlers.push(h);
  }
  onError(h: TransportErrorHandler): void {
    this.errHandlers.push(h);
  }
  onClose(h: TransportCloseHandler): void {
    this.closeHandlers.push(h);
  }

  protected emitMessage(m: JsonRpcMessage): void {
    for (const h of this.msgHandlers) {
      try {
        h(m);
      } catch {
        /* handler errors swallowed */
      }
    }
  }
  protected emitError(err: Error): void {
    for (const h of this.errHandlers) {
      try {
        h(err);
      } catch {
        /* ignore */
      }
    }
  }
  protected emitClose(reason?: string): void {
    for (const h of this.closeHandlers) {
      try {
        h(reason);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 线分帧 framer：从增量字节流中提取 `\n` 结尾的一行 JSON 并解析。
 * - 输入任意 chunk（string 或 Buffer）
 * - 返回成功解析的 JsonRpcMessage[] 和残余 buffer
 * - 无效 JSON 行交由 onParseError 处理（默认静默丢弃，可注入）
 */
export class LineFramer {
  private buf = '';
  constructor(private readonly onParseError?: (line: string, err: unknown) => void) {}

  push(chunk: string | Uint8Array): JsonRpcMessage[] {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    this.buf += text;
    const msgs: JsonRpcMessage[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as JsonRpcMessage;
        msgs.push(obj);
      } catch (e) {
        this.onParseError?.(line, e);
      }
    }
    return msgs;
  }

  reset(): void {
    this.buf = '';
  }

  get pending(): string {
    return this.buf;
  }
}
