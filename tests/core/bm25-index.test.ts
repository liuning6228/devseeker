/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Bm25Index 单测（W13.4-E6）
 *
 * 覆盖：tokenize 中英混合 + BM25 基础检索 + 长度归一化 + upsert/delete/clear + 持久化。
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import {
  Bm25Index,
  bm25Tokenize,
  type Bm25Record,
} from '../../src/core/index/index.js';

function rec(id: string, filePath: string, text: string, startLine = 1, endLine = 10): Bm25Record {
  return { id, filePath, startLine, endLine, text };
}

describe('bm25Tokenize', () => {
  it('切英文单词小写化 + 过滤停用词', () => {
    const toks = bm25Tokenize('The Quick Brown Fox');
    expect(toks).toEqual(['quick', 'brown', 'fox']);
  });

  it('过滤单字母英文 token', () => {
    const toks = bm25Tokenize('a b c foo');
    expect(toks).toEqual(['foo']);
  });

  it('CJK 按字 unigram 切分', () => {
    const toks = bm25Tokenize('中文分词');
    // '的/是/了/在' 等停用词不在此句
    expect(toks).toEqual(['中', '文', '分', '词']);
  });

  it('中英混合：英文段 + 中文逐字', () => {
    const toks = bm25Tokenize('使用 TypeScript 实现');
    expect(toks).toContain('typescript');
    expect(toks).toContain('使');
    expect(toks).toContain('用');
    expect(toks).toContain('实');
    expect(toks).toContain('现');
  });

  it('中文停用词 `的/是/了` 被过滤', () => {
    const toks = bm25Tokenize('这是一个的了');
    // 只剩 '这/一/个'（'是/的/了' 属停用词）
    expect(toks).not.toContain('是');
    expect(toks).not.toContain('的');
    expect(toks).not.toContain('了');
    expect(toks).toContain('这');
  });

  it('空串/仅空白 → []', () => {
    expect(bm25Tokenize('')).toEqual([]);
    expect(bm25Tokenize('   \n\t')).toEqual([]);
  });
});

describe('Bm25Index · 构建与检索', () => {
  it('初始状态为空 + search 返回 []', () => {
    const idx = new Bm25Index();
    expect(idx.size()).toBe(0);
    expect(idx.search('anything')).toEqual([]);
  });

  it('upsert + search 返回最相关文档', () => {
    const idx = new Bm25Index();
    idx.upsert([
      rec('r1', 'a.ts', 'the quick brown fox jumps over the lazy dog'),
      rec('r2', 'b.ts', 'typescript generics inference'),
      rec('r3', 'c.ts', 'python pandas dataframe filter'),
    ]);
    const hits = idx.search('typescript generics', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].record.id).toBe('r2');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('中文查询命中中文文档', () => {
    const idx = new Bm25Index();
    idx.upsert([
      rec('r1', 'a.ts', '通义千问大模型'),
      rec('r2', 'b.ts', '文心一言对话引擎'),
      rec('r3', 'c.ts', 'openai gpt-4 english only'),
    ]);
    const hits = idx.search('通义千问', 3);
    expect(hits[0].record.id).toBe('r1');
  });

  it('中英混合查询跨语料命中', () => {
    const idx = new Bm25Index();
    idx.upsert([
      rec('r1', 'x.ts', 'implement BM25 score function in TypeScript'),
      rec('r2', 'y.ts', '实现 BM25 检索算法'),
      rec('r3', 'z.ts', 'unrelated python numpy code'),
    ]);
    const hits = idx.search('BM25 算法', 3);
    expect(hits.length).toBeGreaterThan(0);
    // r2 含 'BM25' + '算' + '法' 全部命中，应第一
    expect(hits[0].record.id).toBe('r2');
  });

  it('长度归一化：相同 tf 下短文档得分更高', () => {
    const idx = new Bm25Index();
    // 两文档都只有 1 次 'fox'，但长文档被大量无关词拉长
    const longText = 'fox ' + 'unrelated '.repeat(100);
    idx.upsert([
      rec('long', 'a.ts', longText),
      rec('short', 'b.ts', 'fox jumps'),
    ]);
    const hits = idx.search('fox', 2);
    // 同 tf(fox)=1 时，短文档因 lenNorm 更小分母更小，应优先
    expect(hits[0].record.id).toBe('short');
  });

  it('topK 截断', () => {
    const idx = new Bm25Index();
    idx.upsert([
      rec('r1', 'a.ts', 'alpha beta gamma'),
      rec('r2', 'b.ts', 'alpha delta epsilon'),
      rec('r3', 'c.ts', 'alpha zeta eta'),
    ]);
    const hits = idx.search('alpha', 2);
    expect(hits).toHaveLength(2);
  });

  it('不相关查询返回 []', () => {
    const idx = new Bm25Index();
    idx.upsert([rec('r1', 'a.ts', 'fox dog cat')]);
    expect(idx.search('zzz nonexistent')).toEqual([]);
  });

  it('空 query / topK<=0 → []', () => {
    const idx = new Bm25Index();
    idx.upsert([rec('r1', 'a.ts', 'hello world')]);
    expect(idx.search('', 10)).toEqual([]);
    expect(idx.search('hello', 0)).toEqual([]);
  });
});

describe('Bm25Index · 增量维护', () => {
  it('upsert 覆盖同 id 文档：旧 df 被回退', () => {
    const idx = new Bm25Index();
    idx.upsert([rec('r1', 'a.ts', 'fox jumps')]);
    idx.upsert([rec('r1', 'a.ts', 'cat runs')]); // 覆盖
    expect(idx.size()).toBe(1);
    expect(idx.search('fox')).toEqual([]);
    const catHits = idx.search('cat');
    expect(catHits[0]?.record.id).toBe('r1');
  });

  it('deleteByFile 移除该文件所有 chunk', () => {
    const idx = new Bm25Index();
    idx.upsert([
      rec('r1', 'a.ts', 'fox jumps'),
      rec('r2', 'a.ts', 'fox runs'),
      rec('r3', 'b.ts', 'cat sleeps'),
    ]);
    const removed = idx.deleteByFile('a.ts');
    expect(removed).toBe(2);
    expect(idx.size()).toBe(1);
    expect(idx.search('fox')).toEqual([]);
    expect(idx.search('cat')[0]?.record.id).toBe('r3');
  });

  it('clear 清空全部状态', () => {
    const idx = new Bm25Index();
    idx.upsert([rec('r1', 'a.ts', 'hello world')]);
    idx.clear();
    expect(idx.size()).toBe(0);
    expect(idx.search('hello')).toEqual([]);
  });

  it('listIndexedFiles 返回去重后的路径', () => {
    const idx = new Bm25Index();
    idx.upsert([
      rec('r1', 'a.ts', 'x'),
      rec('r2', 'a.ts', 'y'),
      rec('r3', 'b.ts', 'z'),
    ]);
    expect(idx.listIndexedFiles()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('Bm25Index · 持久化', () => {
  it('toSnapshot / fromSnapshot 往返保持语料', () => {
    const a = new Bm25Index({ k1: 1.2, b: 0.5 });
    a.upsert([
      rec('r1', 'a.ts', 'typescript generics'),
      rec('r2', 'b.ts', '中文检索'),
    ]);
    const snap = a.toSnapshot();
    expect(snap.flavor).toBe('bm25');
    expect(snap.version).toBe(1);
    expect(snap.k1).toBe(1.2);
    expect(snap.b).toBe(0.5);

    const b = Bm25Index.fromSnapshot(snap);
    expect(b.size()).toBe(2);
    const hits = b.search('typescript');
    expect(hits[0].record.id).toBe('r1');
  });

  it('saveToFile / loadFromFile 端到端', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'bm25-'));
    const path = join(dir, 'bm25.json');
    try {
      const a = new Bm25Index();
      a.upsert([rec('r1', 'a.ts', 'alpha beta')]);
      await a.saveToFile(path);

      const b = await Bm25Index.loadFromFile(path);
      expect(b).toBeDefined();
      expect(b!.size()).toBe(1);
      expect(b!.search('alpha')[0].record.id).toBe('r1');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loadFromFile 不存在路径返回 undefined', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'bm25-'));
    try {
      const res = await Bm25Index.loadFromFile(join(dir, 'nonexistent.json'));
      expect(res).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loadFromFile 破损 JSON 抛 INDEX_DB_CORRUPTED', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'bm25-'));
    const path = join(dir, 'bm25.json');
    try {
      await fs.writeFile(path, '{not valid json', 'utf-8');
      await expect(Bm25Index.loadFromFile(path)).rejects.toThrow(/JSON 解析失败/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fromSnapshot 拒绝未知 flavor / 版本', () => {
    expect(() =>
      Bm25Index.fromSnapshot({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        version: 2 as any,
        flavor: 'bm25',
        k1: 1.5,
        b: 0.75,
        createdAt: 0,
        updatedAt: 0,
        records: [],
      }),
    ).toThrow();
  });
});
