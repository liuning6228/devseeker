/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * LRU + TTL 缓存测试（W8.10 / DESIGN §M12.5）
 */

import { describe, it, expect } from 'vitest';
import { LruCache } from '../../src/core/web/cache.js';

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const c = new LruCache<string, number>({ maxSize: 3, ttlMs: 1000 });
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
  });

  it('returns undefined for missing keys', () => {
    const c = new LruCache<string, number>({ maxSize: 3, ttlMs: 1000 });
    expect(c.get('nope')).toBeUndefined();
  });

  it('evicts LRU when exceeding maxSize', () => {
    const c = new LruCache<string, number>({ maxSize: 2, ttlMs: 0 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3); // evicts 'a'
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
  });

  it('promotes on get (LRU touch)', () => {
    const c = new LruCache<string, number>({ maxSize: 2, ttlMs: 0 });
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // a becomes most recent
    c.set('c', 3); // should evict 'b' (least recent), not 'a'
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toBe(3);
  });

  it('expires entries after ttlMs', () => {
    let now = 1000;
    const c = new LruCache<string, number>({ maxSize: 3, ttlMs: 500, now: () => now });
    c.set('a', 1);
    now = 1400;
    expect(c.get('a')).toBe(1); // not yet expired
    now = 1600;
    expect(c.get('a')).toBeUndefined(); // expired
  });

  it('ttlMs=0 means never expire', () => {
    let now = 1000;
    const c = new LruCache<string, number>({ maxSize: 3, ttlMs: 0, now: () => now });
    c.set('a', 1);
    now = 1_000_000_000;
    expect(c.get('a')).toBe(1);
  });

  it('overwrite existing key refreshes ttl and promotes to MRU', () => {
    let now = 1000;
    const c = new LruCache<string, number>({ maxSize: 2, ttlMs: 500, now: () => now });
    c.set('a', 1);
    c.set('b', 2);
    now = 1400;
    c.set('a', 10); // refresh
    now = 1800;
    expect(c.get('a')).toBe(10); // not expired
    // writing c should evict 'b', not 'a'
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(10);
    expect(c.get('c')).toBe(3);
  });

  it('delete() removes entry', () => {
    const c = new LruCache<string, number>({ maxSize: 3, ttlMs: 0 });
    c.set('a', 1);
    expect(c.delete('a')).toBe(true);
    expect(c.get('a')).toBeUndefined();
    expect(c.delete('a')).toBe(false);
  });

  it('clear() removes all', () => {
    const c = new LruCache<string, number>({ maxSize: 3, ttlMs: 0 });
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });

  it('throws on maxSize <= 0', () => {
    expect(() => new LruCache({ maxSize: 0, ttlMs: 0 })).toThrow();
  });

  it('keys() returns LRU order (oldest first)', () => {
    const c = new LruCache<string, number>({ maxSize: 3, ttlMs: 0 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.get('a'); // a becomes newest
    expect(c.keys()).toEqual(['b', 'c', 'a']);
  });
});
