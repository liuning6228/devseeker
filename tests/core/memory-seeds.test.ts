/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 内置种子记忆单测（B-P3-4 · W5.11）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/core/memory/store.js';
import {
  BUILTIN_MEMORY_SEEDS,
  ensureSeedMemories,
  type MemorySeed,
} from '../../src/core/memory/seeds.js';
import { WRITABLE_CATEGORIES } from '../../src/core/memory/categories.js';

let tmpRoot: string;
let globalRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'mem-seed-ws-'));
  globalRoot = await fs.mkdtemp(join(os.tmpdir(), 'mem-seed-gl-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(globalRoot, { recursive: true, force: true });
});

function makeStore(): MemoryStore {
  return new MemoryStore({ workspaceRoot: tmpRoot, globalRoot });
}

describe('memory seeds · BUILTIN_MEMORY_SEEDS', () => {
  it('恰好 10 条种子', () => {
    expect(BUILTIN_MEMORY_SEEDS.length).toBe(10);
  });

  it('所有 category 都在 WRITABLE_CATEGORIES 内', () => {
    const writable = new Set<string>(WRITABLE_CATEGORIES as readonly string[]);
    for (const s of BUILTIN_MEMORY_SEEDS) {
      expect(writable.has(s.category)).toBe(true);
    }
  });

  it('每条 title/content/keywords 均非空', () => {
    for (const s of BUILTIN_MEMORY_SEEDS) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.content.trim().length).toBeGreaterThan(0);
      expect(s.keywords.length).toBeGreaterThan(0);
    }
  });

  it('title 无重复', () => {
    const titles = BUILTIN_MEMORY_SEEDS.map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('至少覆盖 4 种不同 category', () => {
    const cats = new Set(BUILTIN_MEMORY_SEEDS.map((s) => s.category));
    expect(cats.size).toBeGreaterThanOrEqual(4);
  });
});

describe('memory seeds · ensureSeedMemories', () => {
  it('空 store 写入 10 条并返回 records', async () => {
    const store = makeStore();
    const res = await ensureSeedMemories(store);
    expect(res.seeded).toBe(true);
    expect(res.created).toBe(10);
    expect(res.skipReason).toBeUndefined();
    expect(res.records?.length).toBe(10);
    for (const r of res.records!) {
      expect(r.id).toMatch(/^mem_/);
      expect(typeof r.createdAt).toBe('number');
      expect(typeof r.updatedAt).toBe('number');
      expect(r.scope).toBe('workspace');
    }
    const list = await store.list({ scope: 'workspace' });
    expect(list.length).toBe(10);
  });

  it('已有记忆则跳过，返回 skipReason=already_has_memories', async () => {
    const store = makeStore();
    await store.create({
      title: '用户已有',
      content: 'pre-existing',
      category: 'user_hobby',
      keywords: ['x'],
    });
    const res = await ensureSeedMemories(store);
    expect(res.seeded).toBe(false);
    expect(res.created).toBe(0);
    expect(res.skipReason).toBe('already_has_memories');
    const list = await store.list({ scope: 'workspace' });
    expect(list.length).toBe(1); // 没有被种子淹没
  });

  it('二次调用同一空 store 后不再重复写入', async () => {
    const store = makeStore();
    const r1 = await ensureSeedMemories(store);
    expect(r1.seeded).toBe(true);
    const r2 = await ensureSeedMemories(store);
    expect(r2.seeded).toBe(false);
    expect(r2.created).toBe(0);
    const list = await store.list({ scope: 'workspace' });
    expect(list.length).toBe(10);
  });

  it('支持自定义 seeds 参数', async () => {
    const store = makeStore();
    const customSeeds: MemorySeed[] = [
      {
        title: 'Custom Seed A',
        content: 'aaa',
        category: 'user_info',
        keywords: ['k1'],
      },
      {
        title: 'Custom Seed B',
        content: 'bbb',
        category: 'user_hobby',
        keywords: ['k2', 'k3'],
      },
    ];
    const res = await ensureSeedMemories(store, { seeds: customSeeds });
    expect(res.seeded).toBe(true);
    expect(res.created).toBe(2);
    const list = await store.list({ scope: 'workspace' });
    expect(list.length).toBe(2);
    const titles = list.map((r) => r.title).sort();
    expect(titles).toEqual(['Custom Seed A', 'Custom Seed B']);
  });

  it('scope=global 时写入 global 且不影响 workspace', async () => {
    const store = makeStore();
    const res = await ensureSeedMemories(store, { scope: 'global' });
    expect(res.seeded).toBe(true);
    expect(res.created).toBe(10);
    // workspace 仍然空
    const wsList = await store.list({ scope: 'workspace' });
    expect(wsList.length).toBe(0);
    const glList = await store.list({ scope: 'global' });
    expect(glList.length).toBe(10);
  });

  it('seed 的 keywords 被规范化（去重/去空）', async () => {
    const store = makeStore();
    const res = await ensureSeedMemories(store, {
      seeds: [
        {
          title: 'kw normalize',
          content: 'x',
          category: 'user_hobby',
          keywords: ['a', 'A', ' ', 'b'],
        },
      ],
    });
    expect(res.seeded).toBe(true);
    const rec = res.records![0];
    // 规范化后：保留首个 'a'（大小写不敏感去重）、'b'；空白被去掉
    expect(rec.keywords.length).toBe(2);
    expect(rec.keywords[0]).toBe('a');
    expect(rec.keywords[1]).toBe('b');
  });
});
