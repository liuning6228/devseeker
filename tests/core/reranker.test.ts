/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W11.7 · Reranker 单测
 *
 * 覆盖：
 * 1. extractKeywords 基本分词/停用词/去重/最小长度
 * 2. keywordRerank 路径命中加权
 * 3. keywordRerank 正文频次加权
 * 4. test 目录降权（除非查询带 test）
 * 5. 空查询/空候选 fallback
 * 6. 输出按 finalScore 降序、不修改入参
 * 7. topK 截断
 */

import { describe, it, expect } from 'vitest';
import {
  keywordRerank,
  extractKeywords,
  type Rankable,
} from '../../src/core/index/reranker.js';

describe('extractKeywords', () => {
  it('切分、去停用词、去重、小写化', () => {
    const out = extractKeywords('How does the User Login work? login login.');
    expect(out).toContain('user');
    expect(out).toContain('login');
    expect(out).toContain('work');
    expect(out).not.toContain('the');
    expect(out).not.toContain('how');
    // 去重
    expect(out.filter((w) => w === 'login').length).toBe(1);
  });

  it('过滤短词（<minKeywordLen）', () => {
    const out = extractKeywords('a b cd ef', 2);
    expect(out).not.toContain('a');
    expect(out).not.toContain('b');
    expect(out).toContain('cd');
    expect(out).toContain('ef');
  });

  it('支持中文切分（连续 CJK 视为一个 token）', () => {
    const out = extractKeywords('如何实现 用户登录 流程');
    expect(out).toContain('如何实现');
    expect(out).toContain('用户登录');
    expect(out).toContain('流程');
  });
});

describe('keywordRerank', () => {
  function mk(filePath: string, text: string, score: number): Rankable {
    return { filePath, text, score };
  }

  it('路径命中关键词的候选排在更前', () => {
    const cands: Rankable[] = [
      mk('src/core/util.ts', 'misc helpers', 0.8),
      mk('src/core/auth/login.ts', 'placeholder', 0.8),
    ];
    const out = keywordRerank('login flow', cands);
    expect(out[0].filePath).toBe('src/core/auth/login.ts');
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('正文关键词出现次数越多排得越高', () => {
    const cands: Rankable[] = [
      mk('a.ts', 'foo bar', 0.5),
      mk('b.ts', 'login login login userName', 0.5),
    ];
    const out = keywordRerank('login user', cands);
    expect(out[0].filePath).toBe('b.ts');
  });

  it('test/spec 目录降权；查询带 test 时不降权', () => {
    const cands: Rankable[] = [
      mk('src/auth/login.ts', 'code', 0.6),
      mk('tests/auth/login.test.ts', 'code', 0.6),
    ];
    const withoutTestQ = keywordRerank('login', cands);
    expect(withoutTestQ[0].filePath).toBe('src/auth/login.ts');

    const withTestQ = keywordRerank('login test', cands);
    // 两者都命中关键词且 test 查询抑制了降权，test 文件因多命中 path 一词而排前
    expect(withTestQ[0].filePath).toBe('tests/auth/login.test.ts');
  });

  it('无关键词或空候选时按原 score 降序 fallback', () => {
    const cands: Rankable[] = [
      mk('a.ts', '', 0.3),
      mk('b.ts', '', 0.9),
    ];
    const out = keywordRerank('a the of', cands); // 全是停用词
    expect(out.map((c) => c.filePath)).toEqual(['b.ts', 'a.ts']);

    const empty = keywordRerank('login', []);
    expect(empty).toEqual([]);
  });

  it('不修改入参', () => {
    const original: Rankable[] = [
      { filePath: 'src/login.ts', text: 'x', score: 0.5 },
      { filePath: 'src/other.ts', text: 'x', score: 0.5 },
    ];
    const snapshot = JSON.stringify(original);
    keywordRerank('login', original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('topK 截断结果数', () => {
    const cands: Rankable[] = [
      { filePath: 'a', text: 'login', score: 0.1 },
      { filePath: 'b', text: 'login login', score: 0.1 },
      { filePath: 'c', text: 'login login login', score: 0.1 },
    ];
    const out = keywordRerank('login', cands, { topK: 2 });
    expect(out.length).toBe(2);
    expect(out[0].filePath).toBe('c');
    expect(out[1].filePath).toBe('b');
  });
});
