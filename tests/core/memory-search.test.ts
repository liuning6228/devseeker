/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * searchMemories 单测（W4 批次 2）
 */

import { describe, it, expect } from 'vitest';
import { searchMemories } from '../../src/core/memory/search.js';
import type { MemoryRecord } from '../../src/core/memory/types.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

function mk(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: over.id ?? 'mem_1',
    title: over.title ?? 'Hello World',
    content: over.content ?? '',
    category: over.category ?? 'user_info',
    keywords: over.keywords ?? [],
    scope: over.scope ?? 'workspace',
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
  };
}

describe('searchMemories - fetch', () => {
  it('returns exact title match', () => {
    const recs = [
      mk({ id: '1', title: 'W1 MVP 完成' }),
      mk({ id: '2', title: 'W2 架构升级' }),
    ];
    const out = searchMemories(recs, { depth: 'fetch', query: 'W1 MVP 完成' });
    expect(out.kind).toBe('hits');
    if (out.kind !== 'hits') return;
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].record.id).toBe('1');
    expect(out.hits[0].score).toBe(1);
  });

  it('fetch supports multiple comma-separated titles', () => {
    const recs = [
      mk({ id: '1', title: 'A' }),
      mk({ id: '2', title: 'B' }),
      mk({ id: '3', title: 'C' }),
    ];
    const out = searchMemories(recs, { depth: 'fetch', query: 'A, C' });
    if (out.kind !== 'hits') throw new Error('expected hits');
    expect(out.hits.map((h) => h.record.id).sort()).toEqual(['1', '3']);
  });

  it('fetch returns empty when no match', () => {
    const out = searchMemories([mk({ title: 'A' })], { depth: 'fetch', query: 'Z' });
    if (out.kind !== 'hits') throw new Error('expected hits');
    expect(out.hits).toEqual([]);
  });
});

describe('searchMemories - shallow', () => {
  it('scores title match > keyword match > content match', () => {
    const recs = [
      mk({ id: 't', title: 'DeepSeek reasoning bug', content: 'other' }),
      mk({ id: 'k', title: 'irrelevant', keywords: ['DeepSeek'], content: 'other' }),
      mk({ id: 'c', title: 'irrelevant', content: 'issue about DeepSeek content' }),
    ];
    const out = searchMemories(recs, {
      depth: 'shallow',
      query: '',
      keywords: ['DeepSeek'],
    });
    if (out.kind !== 'hits') throw new Error('expected hits');
    expect(out.hits[0].record.id).toBe('t');
    expect(out.hits[1].record.id).toBe('k');
    expect(out.hits[2].record.id).toBe('c');
  });

  it('respects category filter', () => {
    const recs = [
      mk({ id: 'a', title: 'x DeepSeek', category: 'user_info' }),
      mk({ id: 'b', title: 'x DeepSeek', category: 'expert_experience' }),
    ];
    const out = searchMemories(recs, {
      depth: 'shallow',
      query: '',
      keywords: ['DeepSeek'],
      category: 'expert_experience',
    });
    if (out.kind !== 'hits') throw new Error('expected hits');
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].record.id).toBe('b');
  });

  it('splits query text into keywords', () => {
    const recs = [mk({ title: 'DeepSeek compat fix' })];
    const out = searchMemories(recs, {
      depth: 'shallow',
      query: 'DeepSeek compat',
    });
    if (out.kind !== 'hits') throw new Error('expected hits');
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].score).toBeGreaterThan(0);
  });

  it('empty keywords returns empty', () => {
    const recs = [mk({ title: 'x' })];
    const out = searchMemories(recs, { depth: 'shallow', query: '' });
    if (out.kind !== 'hits') throw new Error('expected hits');
    expect(out.hits).toEqual([]);
  });
});

describe('searchMemories - deep', () => {
  it('category match adds bonus score', async () => {
    const recs = [
      mk({ id: 'a', title: 'x', content: 'TaskLoop Y', category: 'user_info' }),
      mk({
        id: 'b',
        title: 'x',
        content: 'TaskLoop Y',
        category: 'expert_experience',
      }),
    ];
    // 不带 category 过滤，两条记录都应命中关键词匹配
    const out = await (searchMemories(recs, {
      depth: 'deep',
      query: 'TaskLoop',
    }) as Promise<import('../../src/core/memory/search.js').SearchOutput>);
    if (out.kind !== 'hits') throw new Error('expected hits');
    const b = out.hits.find((h) => h.record.id === 'b')!;
    const a = out.hits.find((h) => h.record.id === 'a')!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // 再传 category 过滤验证加成
    const out2 = await (searchMemories(recs, {
      depth: 'deep',
      query: 'TaskLoop',
      category: 'expert_experience',
    }) as Promise<import('../../src/core/memory/search.js').SearchOutput>);
    if (out2.kind !== 'hits') throw new Error('expected hits');
    const b2 = out2.hits.find((h) => h.record.id === 'b')!;
    expect(b2).toBeDefined();
    expect(b2.score).toBeGreaterThan(b.score);
    expect(b2.matchedOn).toContain('category');
  });
});

describe('searchMemories - explore', () => {
  it('returns top-level groups when query empty', () => {
    const out = searchMemories([], { depth: 'explore', query: '' });
    expect(out.kind).toBe('explore');
    if (out.kind !== 'explore') return;
    expect(out.groups).toContain('user');
    expect(out.groups).toContain('project');
    expect(out.groups).toContain('experience');
  });

  it('lists subcategories + titles when path = "user"', () => {
    const recs = [
      mk({ id: '1', title: 'name', category: 'user_info' }),
      mk({ id: '2', title: 'hobby', category: 'user_hobby' }),
      mk({ id: '3', title: 'irrelevant', category: 'project_tech_stack' }),
    ];
    const out = searchMemories(recs, { depth: 'explore', query: 'user' });
    if (out.kind !== 'explore') throw new Error('expected explore');
    expect(out.groups).toContain('user-user_info');
    expect(out.groups).toContain('user-user_hobby');
    expect(out.titles.map((t) => t.id).sort()).toEqual(['1', '2']);
  });

  it('returns only target category titles on path = "user-user_info"', () => {
    const recs = [
      mk({ id: '1', title: 'name', category: 'user_info' }),
      mk({ id: '2', title: 'hobby', category: 'user_hobby' }),
    ];
    const out = searchMemories(recs, {
      depth: 'explore',
      query: 'user-user_info',
    });
    if (out.kind !== 'explore') throw new Error('expected explore');
    expect(out.titles).toHaveLength(1);
    expect(out.titles[0].id).toBe('1');
  });

  it('ignores unknown root path', () => {
    const out = searchMemories([mk({ title: 'x' })], {
      depth: 'explore',
      query: 'unknown',
    });
    if (out.kind !== 'explore') throw new Error('expected explore');
    expect(out.groups).toEqual([]);
    expect(out.titles).toEqual([]);
  });
});

describe('searchMemories - invalid depth', () => {
  it('throws MEMORY_SEARCH_INVALID_DEPTH', () => {
    try {
      searchMemories([], {
        depth: 'foo' as any,
        query: '',
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { code?: string }).code).toBe(ErrorCodes.MEMORY_SEARCH_INVALID_DEPTH);
    }
  });
});
