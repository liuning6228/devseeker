/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * FusionSearcher 单测（P3）
 *
 * 覆盖：
 *   - reciprocalRankFusion 纯函数：单路/多路/去重/空输入/分数计算
 *   - routeQuery 查询路由：always-on 源/结构性查询/图索引激活条件
 *   - FusionSearcher 类：注册源/搜索/降级/并行/错误容忍
 */

import { describe, it, expect } from 'vitest';
import {
  reciprocalRankFusion,
  routeQuery,
  FusionSearcher,
  type SearchSource,
} from '../../src/core/index/fusion-searcher.js';
import type { SearchResult } from '../../src/core/index/codebase-index.js';

// ─────────── helpers ───────────

function hit(filePath: string, startLine: number, score: number, text = ''): SearchResult {
  return { filePath, startLine, endLine: startLine + 10, text, score };
}

function makeSource(name: string, results: SearchResult[], sizeOverride?: number): SearchSource {
  return {
    name,
    async search(_query: string, _topK: number) {
      return results;
    },
    size() {
      return sizeOverride ?? results.length;
    },
  };
}

function makeEmptySource(name: string): SearchSource {
  return {
    name,
    async search() { return []; },
    size() { return 0; },
  };
}

// ─────────── reciprocalRankFusion ───────────

describe('reciprocalRankFusion', () => {
  it('空输入 → 空输出', () => {
    const result = reciprocalRankFusion(new Map());
    expect(result).toEqual([]);
  });

  it('单路搜索 → 保持原有顺序', () => {
    const input = new Map<string, SearchResult[]>();
    input.set('codebase', [
      hit('a.ts', 1, 0.9),
      hit('b.ts', 10, 0.8),
      hit('c.ts', 20, 0.7),
    ]);
    const result = reciprocalRankFusion(input, 60);
    expect(result).toHaveLength(3);
    expect(result[0].filePath).toBe('a.ts');
    expect(result[1].filePath).toBe('b.ts');
    expect(result[2].filePath).toBe('c.ts');
    // RRF 分数：1/(60+1), 1/(60+2), 1/(60+3)
    expect(result[0].rrfScore).toBeCloseTo(1 / 61, 6);
    expect(result[1].rrfScore).toBeCloseTo(1 / 62, 6);
    expect(result[2].rrfScore).toBeCloseTo(1 / 63, 6);
  });

  it('多路融合 → 重复文档分数叠加', () => {
    const input = new Map<string, SearchResult[]>();
    // 两路搜索都命中了 a.ts
    input.set('codebase', [
      hit('a.ts', 1, 0.9),
      hit('b.ts', 10, 0.8),
    ]);
    input.set('bm25', [
      hit('a.ts', 1, 0.95),  // 与 codebase 的第 1 名重复
      hit('c.ts', 20, 0.7),
    ]);
    const result = reciprocalRankFusion(input, 60);
    // a.ts 在两路都是 rank 0，RRF = 1/61 + 1/61 = 2/61
    expect(result[0].filePath).toBe('a.ts');
    expect(result[0].rrfScore).toBeCloseTo(2 / 61, 6);
    expect(result[0].sources).toEqual(['codebase', 'bm25']);
  });

  it('不同文档按 RRF 分数排序', () => {
    const input = new Map<string, SearchResult[]>();
    input.set('s1', [
      hit('x.ts', 1, 0.5),  // rank 0 → 1/61
      hit('y.ts', 10, 0.4), // rank 1 → 1/62
    ]);
    input.set('s2', [
      hit('y.ts', 10, 0.6), // rank 0 → 1/61
      hit('z.ts', 20, 0.3), // rank 1 → 1/62
    ]);
    const result = reciprocalRankFusion(input, 60);
    // y.ts: 1/62 + 1/61 ≈ 0.0328（两路都命中，排名高）
    // x.ts: 1/61 ≈ 0.0164（只在 s1 命中）
    // z.ts: 1/62 ≈ 0.0161（只在 s2 命中）
    expect(result[0].filePath).toBe('y.ts');
    expect(result[0].sources).toContain('s1');
    expect(result[0].sources).toContain('s2');
    expect(result).toHaveLength(3);
  });

  it('k 值影响分数分布', () => {
    const input = new Map<string, SearchResult[]>();
    input.set('s1', [hit('a.ts', 1, 0.9)]);

    const r1 = reciprocalRankFusion(input, 1);
    const r10 = reciprocalRankFusion(input, 10);

    // k=1: 1/(1+1) = 0.5
    expect(r1[0].rrfScore).toBeCloseTo(0.5, 6);
    // k=10: 1/(10+1) ≈ 0.0909
    expect(r10[0].rrfScore).toBeCloseTo(1 / 11, 6);
  });

  it('去重：同一文档不同行范围视为不同结果', () => {
    const input = new Map<string, SearchResult[]>();
    input.set('s1', [
      hit('a.ts', 1, 0.9),
      hit('a.ts', 50, 0.7),  // 同文件不同行
    ]);
    const result = reciprocalRankFusion(input, 60);
    // 不同行范围 → 不同 docKey
    expect(result).toHaveLength(2);
  });
});

// ─────────── routeQuery ───────────

describe('routeQuery', () => {
  it('始终激活 codebase + bm25', () => {
    const sources = new Map<string, SearchSource>();
    sources.set('codebase', makeSource('codebase', [hit('a.ts', 1, 0.5)]));
    sources.set('bm25', makeSource('bm25', [hit('a.ts', 1, 0.5)]));

    const route = routeQuery('简单搜索', sources);
    expect(route.sources).toContain('codebase');
    expect(route.sources).toContain('bm25');
    expect(route.sources).not.toContain('graph');
  });

  it('跳过 size=0 的源', () => {
    const sources = new Map<string, SearchSource>();
    sources.set('codebase', makeEmptySource('codebase'));
    sources.set('bm25', makeSource('bm25', [hit('a.ts', 1, 0.5)]));

    const route = routeQuery('搜索', sources);
    expect(route.sources).not.toContain('codebase');
    expect(route.sources).toContain('bm25');
  });

  it('包含调用关系关键词 → 激活 graph', () => {
    const sources = new Map<string, SearchSource>();
    sources.set('codebase', makeSource('codebase', [hit('a.ts', 1, 0.5)]));
    sources.set('bm25', makeSource('bm25', [hit('a.ts', 1, 0.5)]));
    sources.set('graph', makeSource('graph', [hit('a.ts', 1, 0.5)]));

    const route = routeQuery('handleToolCall 的调用者', sources);
    expect(route.sources).toContain('graph');
  });

  it('包含方法调用模式 → 激活 graph', () => {
    const sources = new Map<string, SearchSource>();
    sources.set('codebase', makeSource('codebase', [hit('a.ts', 1, 0.5)]));
    sources.set('bm25', makeSource('bm25', [hit('a.ts', 1, 0.5)]));
    sources.set('graph', makeSource('graph', [hit('a.ts', 1, 0.5)]));

    const route = routeQuery('store.create() 在哪里', sources);
    expect(route.sources).toContain('graph');
  });

  it('PascalCase 标识符 → 激活 graph', () => {
    const sources = new Map<string, SearchSource>();
    sources.set('codebase', makeSource('codebase', [hit('a.ts', 1, 0.5)]));
    sources.set('bm25', makeSource('bm25', [hit('a.ts', 1, 0.5)]));
    sources.set('graph', makeSource('graph', [hit('a.ts', 1, 0.5)]));

    const route = routeQuery('MemoryStore 的依赖', sources);
    expect(route.sources).toContain('graph');
  });

  it('graph 源未就绪时不激活', () => {
    const sources = new Map<string, SearchSource>();
    sources.set('codebase', makeSource('codebase', [hit('a.ts', 1, 0.5)]));
    sources.set('bm25', makeSource('bm25', [hit('a.ts', 1, 0.5)]));
    sources.set('graph', makeEmptySource('graph'));

    const route = routeQuery('handleToolCall 的调用者', sources);
    expect(route.sources).not.toContain('graph');
  });
});

// ─────────── FusionSearcher ───────────

describe('FusionSearcher', () => {
  it('注册源 + 获取源名称', () => {
    const searcher = new FusionSearcher();
    searcher.registerSource(makeSource('codebase', []));
    searcher.registerSource(makeSource('bm25', []));
    expect(searcher.getSourceNames().sort()).toEqual(['bm25', 'codebase']);
  });

  it('空查询 → 空结果', async () => {
    const searcher = new FusionSearcher();
    searcher.registerSource(makeSource('codebase', [hit('a.ts', 1, 0.5)]));
    const result = await searcher.search('', 10);
    expect(result.hits).toHaveLength(0);
  });

  it('无就绪源 → 空结果', async () => {
    const searcher = new FusionSearcher();
    searcher.registerSource(makeEmptySource('codebase'));
    const result = await searcher.search('test', 10);
    expect(result.hits).toHaveLength(0);
    expect(result.activeSources).toHaveLength(0);
  });

  it('多路搜索 + RRF 融合', async () => {
    const searcher = new FusionSearcher();
    searcher.registerSource(makeSource('codebase', [
      hit('a.ts', 1, 0.9),
      hit('b.ts', 10, 0.8),
    ]));
    searcher.registerSource(makeSource('bm25', [
      hit('a.ts', 1, 0.95),
      hit('c.ts', 20, 0.7),
    ]));

    const result = await searcher.search('test query', 10);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.activeSources).toContain('codebase');
    expect(result.activeSources).toContain('bm25');
    // a.ts 被两路命中，应排在前面
    expect(result.hits[0].filePath).toBe('a.ts');
    expect(result.hits[0].sources).toContain('codebase');
    expect(result.hits[0].sources).toContain('bm25');
  });

  it('topK 限制生效', async () => {
    const searcher = new FusionSearcher();
    searcher.registerSource(makeSource('codebase', [
      hit('a.ts', 1, 0.9),
      hit('b.ts', 10, 0.8),
      hit('c.ts', 20, 0.7),
      hit('d.ts', 30, 0.6),
      hit('e.ts', 40, 0.5),
    ]));

    const result = await searcher.search('test', 2);
    expect(result.hits).toHaveLength(2);
  });

  it('单路失败静默降级', async () => {
    const searcher = new FusionSearcher();
    // 一个正常源 + 一个会抛错的源
    searcher.registerSource(makeSource('codebase', [hit('a.ts', 1, 0.9)]));
    searcher.registerSource({
      name: 'bm25',
      async search() { throw new Error('bm25 broken'); },
      size() { return 10; },
    });

    const result = await searcher.search('test', 10);
    // codebase 的结果仍然返回
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].filePath).toBe('a.ts');
  });

  it('移除搜索源', () => {
    const searcher = new FusionSearcher();
    searcher.registerSource(makeSource('codebase', []));
    searcher.registerSource(makeSource('bm25', []));
    expect(searcher.getSourceNames()).toHaveLength(2);
    searcher.removeSource('bm25');
    expect(searcher.getSourceNames()).toEqual(['codebase']);
  });

  it('getReadySourceCount 只计 size > 0 的源', () => {
    const searcher = new FusionSearcher();
    searcher.registerSource(makeSource('codebase', [hit('a.ts', 1, 0.5)]));
    searcher.registerSource(makeEmptySource('bm25'));
    expect(searcher.getReadySourceCount()).toBe(1);
  });

  it('sourceCounts 反映各路命中数', async () => {
    const searcher = new FusionSearcher();
    searcher.registerSource(makeSource('codebase', [
      hit('a.ts', 1, 0.9),
      hit('b.ts', 10, 0.8),
    ]));
    searcher.registerSource(makeSource('bm25', [
      hit('c.ts', 20, 0.7),
    ]));

    const result = await searcher.search('test', 10);
    expect(result.sourceCounts['codebase']).toBe(2);
    expect(result.sourceCounts['bm25']).toBe(1);
  });
});
