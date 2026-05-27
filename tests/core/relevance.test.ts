/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Relevance 提取算法测试（W8.9 / DESIGN §M12.5）
 *
 * 覆盖：
 * - splitChunks：markdown 标题 / 空行 / 字符窗口 / 过短合并
 * - tokenize：中文单字 + 英文 token ≥ 2 字符
 * - cosine：基本正确性 + 边界（零向量）
 * - scoreByKeyword：tf-idf 打分排序
 * - extractRelevant：noop / 关键词策略 / 语义策略 / SKIP_MARKER / embedder 失败回落
 */

import { describe, it, expect, vi } from 'vitest';
import {
  extractRelevant,
  splitChunks,
  cosine,
  scoreByKeyword,
  tokenize,
  SKIP_MARKER,
} from '../../src/core/web/relevance.js';
import type { Embedder, EmbedResult } from '../../src/core/index/embedder.js';

describe('tokenize', () => {
  it('splits Chinese into single characters', () => {
    const toks = tokenize('网页抓取');
    expect(toks).toEqual(['网', '页', '抓', '取']);
  });

  it('lowercases and filters short ASCII tokens (<2 chars)', () => {
    const toks = tokenize('Hello World a b test 123');
    expect(toks).toEqual(['hello', 'world', 'test', '123']);
  });

  it('handles mixed CN + EN + punctuation', () => {
    const toks = tokenize('搜索 search, 关键词 keyword!');
    expect(toks).toContain('搜');
    expect(toks).toContain('索');
    expect(toks).toContain('search');
    expect(toks).toContain('keyword');
  });

  it('returns empty for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('cosine', () => {
  it('identical vectors = 1', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('orthogonal vectors = 0', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('zero vector returns 0', () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('mismatched lengths return 0', () => {
    expect(cosine([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe('splitChunks', () => {
  it('returns [] for empty input', () => {
    expect(splitChunks('')).toEqual([]);
    expect(splitChunks('   \n  \t\n ')).toEqual([]);
  });

  it('splits by markdown headings', () => {
    const text = '# A\nhello\n\n# B\nworld\n\n# C\nfoo';
    const chunks = splitChunks(text, 1000, 1);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]).toContain('# A');
    expect(chunks.some((c) => c.includes('# B'))).toBe(true);
    expect(chunks.some((c) => c.includes('# C'))).toBe(true);
  });

  it('splits by blank lines within section', () => {
    const text = 'para one\n\npara two\n\npara three';
    const chunks = splitChunks(text, 1000, 1);
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toBe('para one');
    expect(chunks[1]).toBe('para two');
    expect(chunks[2]).toBe('para three');
  });

  it('hard-splits over-long paragraphs by char window', () => {
    const long = 'x'.repeat(3000);
    const chunks = splitChunks(long, 1000, 1);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
  });

  it('merges under-min tiny paragraphs with next', () => {
    const text = 'tiny\n\n' + 'x'.repeat(500);
    const chunks = splitChunks(text, 2000, 100);
    // 'tiny' should be merged with next para
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain('tiny');
    expect(chunks[0]).toContain('x'.repeat(500));
  });
});

describe('scoreByKeyword', () => {
  it('gives higher score to chunks containing query tokens', () => {
    const chunks = [
      'cats are mammals that purr and sleep',
      'airplanes fly through the sky using wings',
      'cats and dogs are common pets in homes',
    ];
    const scores = scoreByKeyword('cats pets', chunks);
    const byIdx = Object.fromEntries(scores.map((s) => [s.idx, s.score]));
    // chunk 2 contains BOTH "cats" and "pets" → highest
    expect(byIdx[2]!).toBeGreaterThan(byIdx[0]!);
    expect(byIdx[2]!).toBeGreaterThan(byIdx[1]!);
    expect(byIdx[1]!).toBe(0); // no query tokens
  });

  it('works with Chinese query', () => {
    const chunks = ['网页抓取的第一步是发起请求', '图片处理需要用到 canvas API', '抓取网页后解析 HTML'];
    const scores = scoreByKeyword('网页抓取', chunks);
    const byIdx = Object.fromEntries(scores.map((s) => [s.idx, s.score]));
    expect(byIdx[0]!).toBeGreaterThan(byIdx[1]!);
    expect(byIdx[2]!).toBeGreaterThan(byIdx[1]!);
  });

  it('returns zero scores when query has no tokens', () => {
    const chunks = ['alpha', 'beta'];
    const scores = scoreByKeyword('', chunks);
    expect(scores.every((s) => s.score === 0)).toBe(true);
  });
});

describe('extractRelevant', () => {
  it('noop when query is empty', async () => {
    const r = await extractRelevant('a'.repeat(5000), { query: '', maxLength: 1000 });
    expect(r.strategy).toBe('noop');
    expect(r.truncated).toBe(false);
    expect(r.content.length).toBe(5000);
  });

  it('noop when content fits within maxLength', async () => {
    const r = await extractRelevant('short content', { query: 'anything', maxLength: 1000 });
    expect(r.strategy).toBe('noop');
    expect(r.truncated).toBe(false);
    expect(r.content).toBe('short content');
  });

  it('uses keyword strategy when embedder absent', async () => {
    // 3 sections, each ~400 chars; only section 2 talks about "taxes"
    const sec1 = '# Animals\n' + 'cats dogs birds '.repeat(25);
    const sec2 = '# Taxes\n' + 'taxes deductions refund '.repeat(20);
    const sec3 = '# Sports\n' + 'soccer basketball tennis '.repeat(20);
    const content = [sec1, sec2, sec3].join('\n\n');

    const r = await extractRelevant(content, {
      query: 'taxes refund',
      maxLength: 600,
    });
    expect(r.strategy).toBe('keyword');
    expect(r.truncated).toBe(true);
    expect(r.content).toContain('taxes');
    // Non-matching sections should not dominate
    expect(r.content.includes('soccer')).toBe(false);
  });

  it('uses semantic strategy when embedder is provided', async () => {
    const sec1 = '# Animals\n' + 'cats dogs birds '.repeat(15);
    const sec2 = '# Taxes\n' + 'taxes deductions refund '.repeat(10);
    const sec3 = '# Sports\n' + 'soccer basketball tennis '.repeat(15);
    const content = [sec1, sec2, sec3].join('\n\n');

    // Fake embedder: returns vectors that have highest cosine w/ query when text contains "taxes"
    const fakeEmbedder: Embedder = {
      dimension: 3,
      modelId: 'fake',
      async embed(inputs: string[]): Promise<EmbedResult> {
        return {
          vectors: inputs.map((t) => {
            if (t.toLowerCase().includes('taxes')) return [1, 0, 0];
            if (t.toLowerCase().includes('cats')) return [0, 1, 0];
            return [0, 0, 1];
          }),
        };
      },
    };

    const r = await extractRelevant(content, {
      query: 'taxes refund',
      maxLength: 500,
      embedder: fakeEmbedder,
    });
    expect(r.strategy).toBe('semantic');
    expect(r.truncated).toBe(true);
    expect(r.content).toContain('taxes');
  });

  it('falls back to keyword when embedder throws', async () => {
    const long = '# Section A\n' + 'alpha '.repeat(200) + '\n\n# Section B\n' + 'query '.repeat(200);
    const failingEmbedder: Embedder = {
      dimension: 3,
      modelId: 'fail',
      async embed(): Promise<EmbedResult> {
        throw new Error('embedder down');
      },
    };
    const r = await extractRelevant(long, {
      query: 'query',
      maxLength: 500,
      embedder: failingEmbedder,
    });
    expect(r.strategy).toBe('keyword');
    expect(r.content).toContain('query');
  });

  it('inserts SKIP_MARKER between non-adjacent selected chunks', async () => {
    // 4 sections; query only matches sec 1 and sec 4 → markers in between
    const content = [
      '# A\nquery matched one here ' + 'pad '.repeat(50),
      '# B\nfiller content ' + 'noise '.repeat(50),
      '# C\nmore filler ' + 'junk '.repeat(50),
      '# D\nanother query hit ' + 'pad '.repeat(50),
    ].join('\n\n');

    const r = await extractRelevant(content, {
      query: 'query',
      maxLength: 800,
    });
    expect(r.strategy).toBe('keyword');
    expect(r.content).toContain(SKIP_MARKER);
  });

  it('respects maxLength budget', async () => {
    const content = '# A\n' + 'x'.repeat(5000);
    const r = await extractRelevant(content, {
      query: 'x',
      maxLength: 1000,
    });
    expect(r.content.length).toBeLessThanOrEqual(1000);
    expect(r.truncated).toBe(true);
  });

  it('preserves original chunk order (not ranked order)', async () => {
    // 3 sections; keyword density: sec 3 > sec 1 > sec 2
    const sec1 = '# A\nquery word appears once in section a plus padding ' + 'x '.repeat(50);
    const sec2 = '# B\nno match here at all ' + 'y '.repeat(50);
    const sec3 = '# C\nquery query query query query query in section c ' + 'z '.repeat(50);
    const content = [sec1, sec2, sec3].join('\n\n');

    const r = await extractRelevant(content, {
      query: 'query',
      maxLength: 600,
    });
    // Should include both sec1 and sec3; sec1 text must appear before sec3 in output
    const iA = r.content.indexOf('section a');
    const iC = r.content.indexOf('section c');
    if (iA !== -1 && iC !== -1) {
      expect(iA).toBeLessThan(iC);
    }
  });

  it('calls embedder exactly once for query+chunks batch', async () => {
    const content = '# A\n' + 'foo '.repeat(200) + '\n\n# B\n' + 'bar '.repeat(200);
    const spy = vi.fn(async (inputs: string[]): Promise<EmbedResult> => ({
      vectors: inputs.map(() => [0.5, 0.5]),
    }));
    const embedder: Embedder = { dimension: 2, modelId: 'spy', embed: spy };
    await extractRelevant(content, {
      query: 'foo',
      maxLength: 300,
      embedder,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const firstCallArg = spy.mock.calls[0]![0];
    // inputs = [query, ...chunks] → length >= 2
    expect(firstCallArg.length).toBeGreaterThanOrEqual(2);
    expect(firstCallArg[0]).toBe('foo');
  });
});
