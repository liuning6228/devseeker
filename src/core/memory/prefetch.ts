/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * L2 后台预取（Phase 5 Phase C Step 9）
 *
 * 在 `TaskLoop.send()` 结束时调用 `queuePrefetch(userMessage)`，不 await。
 * 后台 BM25 + 向量检索（复用现有 searchMemories），结果缓存到 prefetch buffer。
 * 下一次 `send()` 开始时检查 buffer 是否命中当前 query，命中则追加到 tool_result 末尾。
 *
 * prefetch 是异步非阻塞——即使是 0-query-dance，
 * prefetch 结果在下次 send 时也允许为空（零注入）。
 *
 * DESIGN-1.md §4.3 · ROADMAP.md 方案三 Phase C Step 9
 */

import type { MemoryRecord } from './types.js';
import type { Embedder } from '../index/embedder.js';

/** 预取缓存条目 */
interface PrefetchEntry {
  /** 触发的 query */
  query: string;
  /** 预取结果文本（shallow 命中） */
  result: string;
  /** 记忆树骨架（检索差距弥补计划 T3）；无命中时为空串 */
  treeText: string;
  /** 创建时间 */
  createdAt: number;
}

const PREFETCH_TTL_MS = 30_000; // 30s 有效期
const MAX_PREFETCH_CACHE = 3; // 最多缓存 3 条

/**
 * L2 预取器。
 * 每轮 send 结束时调用 queuePrefetch，下一轮 send 前检查命中。
 */
export class PrefetchEngine {
  private cache: PrefetchEntry[] = [];
  private pending: Promise<void> | null = null;

  constructor(
    private readonly listRecords: () => Promise<MemoryRecord[]>,
    private readonly embedder?: Embedder,
  ) {}

  /**
   * 触发预取（不 await）。
   * 在 TaskLoop.send() 结束后调用。
   */
  queuePrefetch(userMessage: string): void {
    if (!userMessage || !userMessage.trim()) return;

    // 清理过期缓存
    this.evictStale();

    // 如果最近已有相似的预取，跳过
    if (this.cache.some((e) => isSimilar(e.query, userMessage))) return;

    this.pending = this.doPrefetch(userMessage).catch(() => {
      // 静默失败
    });
  }

  /**
   * 检查是否命中。在下一轮 send() 开始时调用。
   * 若命中，返回预取内容并清空该字段（条目在 result / treeText 都消费完前保留）。
   */
  consumeHit(query: string): string {
    this.evictStale();
    const idx = this.cache.findIndex((e) => isSimilar(e.query, query));
    if (idx === -1) return '';
    const hit = this.cache[idx];
    const result = hit.result;
    hit.result = '';
    this.maybeDropEntry(idx);
    return result;
  }

  /**
   * T3 · 记忆树骨架预取：与 consumeHit 同生命周期（同 TTL/去重/上限），
   * 按字段消费——consumeHit 拿走 result 后条目仍保留，供本方法取 treeText；
   * 两字段都消费完（或初始为空）才移除条目。
   */
  consumeTreeHit(query: string): string {
    this.evictStale();
    const idx = this.cache.findIndex((e) => isSimilar(e.query, query));
    if (idx === -1) return '';
    const hit = this.cache[idx];
    const treeText = hit.treeText;
    hit.treeText = '';
    this.maybeDropEntry(idx);
    return treeText;
  }

  /** 条目内两字段都为空时移除（consumeHit/consumeTreeHit 共用） */
  private maybeDropEntry(idx: number): void {
    const hit = this.cache[idx];
    if (!hit || (hit.result === '' && hit.treeText === '')) {
      this.cache.splice(idx, 1);
    }
  }

  private async doPrefetch(query: string): Promise<void> {
    const records = await this.listRecords();
    if (records.length === 0) return;
    const { searchMemories } = await import('./search.js');
    const output = searchMemories(records, {
      depth: 'shallow',
      query,
      keywords: query.split(/\s+/).filter(Boolean),
      limit: 3,
    });
    // 处理同步/异步返回值
    const results = output instanceof Promise ? await output : output;
    if (results.kind !== 'hits') return;

    let result = '';
    if (results.hits.length > 0) {
      const lines = ['<prefetch>', `(根据上一轮讨论预取的记忆)`];
      for (const hit of results.hits) {
        lines.push(`- [${hit.record.category}] ${hit.record.title}`);
        if (hit.record.content) lines.push(`  ${hit.record.content.slice(0, 200)}`);
      }
      lines.push('</prefetch>');
      result = lines.join('\n');
    }

    // T3 · 记忆树骨架产线：并行构建，独立缓存字段，无命中为空串
    let treeText = '';
    if (query.trim()) {
      try {
        const { buildMemoryTreeBlock } = await import('./explore-inject.js');
        treeText = buildMemoryTreeBlock(records, query.split(/\s+/).filter(Boolean), {
          maxTitles: 6,
        }) ?? '';
      } catch {
        // 树骨架构建失败不阻断主预取（静默降级为空）
      }
    }

    // 两条产线都为空 → 不缓存
    if (!result && !treeText) return;

    if (this.cache.length >= MAX_PREFETCH_CACHE) {
      this.cache.shift();
    }
    this.cache.push({ query, result, treeText, createdAt: Date.now() });
  }

  private evictStale(): void {
    const now = Date.now();
    this.cache = this.cache.filter((e) => now - e.createdAt < PREFETCH_TTL_MS);
  }

  /** 等待当前正在进行的预取完成（仅用于测试） */
  async flush(): Promise<void> {
    await this.pending;
  }
}

function isSimilar(a: string, b: string): boolean {
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  // 简单判定：短串是长串的子串（忽略大小写）
  return long.toLowerCase().includes(short.toLowerCase());
}
