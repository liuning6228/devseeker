/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 简易 LRU + TTL 缓存（W8.10 / DESIGN §M12.5 §M12.7）
 *
 * 用途：fetch_content 预查缓存，key=`${mode}|${url}`。
 *
 * 设计：
 * - Map 顺序 = LRU 顺序（JS Map 保留插入顺序；访问时 delete+set 提升为最近）
 * - 过期惰性清理：get 时若 expireAt <= now → delete 并返回 undefined
 * - size 上限达成时从头部驱逐最旧项
 * - 无定时器（单测易）；无依赖
 *
 * 限制：
 * - 不做并发锁（VSCode extension 主线程单线程，足够）
 * - 不做持久化（仅内存，进程重启丢失）
 */

export interface LruEntry<V> {
  value: V;
  /** Date.now() 过期时刻；-1 表示永不过期 */
  expireAt: number;
}

export interface LruCacheOptions {
  /** 容量上限 */
  maxSize: number;
  /** TTL 毫秒；<=0 表示永不过期 */
  ttlMs: number;
  /** 注入 now，便于测试 */
  now?: () => number;
}

export class LruCache<K, V> {
  private readonly map = new Map<K, LruEntry<V>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: LruCacheOptions) {
    if (opts.maxSize <= 0) throw new Error('LruCache.maxSize must be > 0');
    this.maxSize = opts.maxSize;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 返回 undefined 表示未命中或已过期 */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expireAt !== -1 && entry.expireAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // LRU touch：删再插 → 移到尾部
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    const expireAt = this.ttlMs > 0 ? this.now() + this.ttlMs : -1;
    this.map.set(key, { value, expireAt });
    while (this.map.size > this.maxSize) {
      const first = this.map.keys().next().value as K | undefined;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  /** 诊断：返回按 LRU 顺序（旧→新）的键列表 */
  keys(): K[] {
    return Array.from(this.map.keys());
  }
}
