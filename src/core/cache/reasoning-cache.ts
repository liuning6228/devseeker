/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W15.2 · ReasoningCache
 *
 * 对 reasoning 模型（deepseek-reasoner 等）的调用结果做内存缓存，
 * 相同 messages 在 TTL 内复用已缓存的 StreamEvent，避免重复 API 调用与等待。
 *
 * 缓存 key：messages 数组的 SHA256（规范化后）。
 * 只缓存成功完成的流（最后一个事件为 done 且 reason ≠ error/aborted）。
 * TTL 默认 5 分钟，可配置。
 */

import { createHash } from 'node:crypto';
import type { Message, StreamEvent } from '../../providers/types.js';

interface CacheEntry {
  events: StreamEvent[];
  ts: number;
}

export interface ReasoningCacheOptions {
  ttlMs?: number;
}

export class ReasoningCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  hits = 0;
  misses = 0;

  constructor(options?: ReasoningCacheOptions) {
    this.ttlMs = options?.ttlMs ?? 5 * 60 * 1000;
  }

  /** 根据 messages 内容生成缓存 key（SHA256） */
  computeKey(messages: Message[]): string {
    const normalized = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      ...(m.name ? { name: m.name } : {}),
      ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    }));
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  }

  /** 获取缓存；过期自动清理 */
  get(key: string): StreamEvent[] | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() - entry.ts > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.events;
  }

  /** 存入缓存 */
  set(key: string, events: StreamEvent[]): void {
    this.cache.set(key, { events, ts: Date.now() });
  }

  /** 清空缓存并重置统计 */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** 当前缓存条目数 */
  size(): number {
    return this.cache.size;
  }
}
