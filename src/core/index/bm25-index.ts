/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 零模型保底文本索引（W13.4-E6 · Phase 3）
 *
 * 经典 Okapi BM25：
 *   score(q, d) = Σ_{t ∈ q} idf(t) * (f(t,d) * (k1 + 1)) / (f(t,d) + k1 * (1 - b + b * |d| / avgdl))
 *
 * 设计边界：
 * - 纯 TS 实现，**零外部依赖**——作为无 embedder / API Key 缺失时的保底检索通路。
 * - 中英混合 tokenize：英文 `[a-zA-Z0-9_]+` 切词小写化；中文按 CJK 字符 unigram。
 * - 停用词：中英常见虚词薄薄一层，避免误杀技术词（如 `in`、`of` 虽是停用词但编程场景少见整词独立作为查询词）。
 * - 接口对齐 {@link InMemoryVectorStore}：upsert / deleteByFile / search / toSnapshot / fromSnapshot /
 *   saveToFile / loadFromFile，便于后续统一检索门面。
 *
 * 非目标：
 * - 不支持 phrase query 与 field-weighted scoring（保持最小实现）。
 * - 不负责挂接到 search_codebase 工具 dispatch（W13.4-C 再做）。
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { AgentError, ErrorCodes } from '../errors/index.js';

// ─────────── 类型 ───────────

export interface Bm25Record {
  /** 全局唯一 id（建议 `${filePath}#${startLine}-${endLine}`） */
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /** chunk 原文（展示用；tokenize 时实时算） */
  text: string;
}

export interface Bm25Hit {
  record: Bm25Record;
  /** BM25 原始分，越大越相关；不同语料不可横向比较 */
  score: number;
}

export interface Bm25Snapshot {
  version: 1;
  flavor: 'bm25';
  k1: number;
  b: number;
  createdAt: number;
  updatedAt: number;
  records: Bm25Record[];
}

export interface Bm25IndexOptions {
  /** 词频饱和系数，推荐 1.2–2.0，默认 1.5 */
  k1?: number;
  /** 长度归一化系数，推荐 0.75，默认 0.75 */
  b?: number;
}

// ─────────── Tokenize ───────────

/** 极简停用词：英文 + 中文，只覆盖高频虚词 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'is', 'and', 'or', 'with',
  'for', 'on', 'at', 'by', 'be', 'this', 'that', 'it', 'as', 'are',
  '的', '是', '了', '在', '和', '或', '与', '也', '就', '都',
]);

const ENGLISH_TOKEN_REGEX = /[a-zA-Z0-9_]+/g;
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * 中英混合 tokenize：
 * - 英文/数字/下划线：整段提取并小写化
 * - CJK 字符：每字独立成 token（unigram，无需分词器）
 * - 过滤长度 < 2 的英文 token（单字母噪声）与停用词
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];

  for (const m of text.matchAll(ENGLISH_TOKEN_REGEX)) {
    const tok = m[0].toLowerCase();
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    tokens.push(tok);
  }

  for (const ch of text) {
    if (CJK_REGEX.test(ch)) {
      if (STOPWORDS.has(ch)) continue;
      tokens.push(ch);
    }
  }
  return tokens;
}

// ─────────── 索引主体 ───────────

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/** 单文档的预计算：tokens 长度 + 词频表 */
interface DocStats {
  length: number;
  tf: Map<string, number>;
}

export class Bm25Index {
  private records: Bm25Record[] = [];
  /** 并行数组：docStats[i] 与 records[i] 对应 */
  private docStats: DocStats[] = [];
  /** term → 出现过该词的文档数（df） */
  private df: Map<string, number> = new Map();
  private createdAt: number;
  private updatedAt: number;

  readonly k1: number;
  readonly b: number;

  constructor(opts: Bm25IndexOptions = {}) {
    this.k1 = opts.k1 ?? DEFAULT_K1;
    this.b = opts.b ?? DEFAULT_B;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
  }

  size(): number {
    return this.records.length;
  }

  /** 按 id 覆盖式插入 */
  upsert(records: Bm25Record[]): void {
    if (!records.length) return;
    const idToIndex = new Map<string, number>();
    this.records.forEach((r, i) => idToIndex.set(r.id, i));

    for (const r of records) {
      const stats = this.computeDocStats(r.text);
      const existing = idToIndex.get(r.id);
      if (existing != null) {
        // 先回退旧文档的 df，再插入新文档
        this.retractDf(this.docStats[existing]);
        this.records[existing] = r;
        this.docStats[existing] = stats;
      } else {
        idToIndex.set(r.id, this.records.length);
        this.records.push(r);
        this.docStats.push(stats);
      }
      this.accumulateDf(stats);
    }
    this.updatedAt = Date.now();
  }

  /** 按 filePath 批量删除（增量更新前置） */
  deleteByFile(filePath: string): number {
    let removed = 0;
    const keptRecords: Bm25Record[] = [];
    const keptStats: DocStats[] = [];
    for (let i = 0; i < this.records.length; i++) {
      if (this.records[i].filePath === filePath) {
        this.retractDf(this.docStats[i]);
        removed++;
      } else {
        keptRecords.push(this.records[i]);
        keptStats.push(this.docStats[i]);
      }
    }
    this.records = keptRecords;
    this.docStats = keptStats;
    if (removed > 0) this.updatedAt = Date.now();
    return removed;
  }

  clear(): void {
    this.records = [];
    this.docStats = [];
    this.df = new Map();
    this.updatedAt = Date.now();
  }

  listIndexedFiles(): string[] {
    return Array.from(new Set(this.records.map((r) => r.filePath))).sort();
  }

  /** Top-K BM25 检索；零结果返回 [] */
  search(query: string, topK = 10): Bm25Hit[] {
    if (topK <= 0 || this.records.length === 0) return [];
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];

    const avgdl = this.averageDocLength();
    if (avgdl === 0) return [];

    const uniqueQueryTerms = Array.from(new Set(qTokens));
    const idf = this.precomputeIdf(uniqueQueryTerms);

    const scored: Bm25Hit[] = [];
    for (let i = 0; i < this.records.length; i++) {
      const stats = this.docStats[i];
      if (stats.length === 0) continue;
      let score = 0;
      const lenNorm = 1 - this.b + (this.b * stats.length) / avgdl;
      for (const t of uniqueQueryTerms) {
        const tf = stats.tf.get(t) ?? 0;
        if (tf === 0) continue;
        const termIdf = idf.get(t) ?? 0;
        if (termIdf <= 0) continue;
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * lenNorm;
        score += termIdf * (numerator / denominator);
      }
      if (score > 0) {
        scored.push({ record: this.records[i], score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  // ─────────── 持久化 ───────────

  toSnapshot(): Bm25Snapshot {
    return {
      version: 1,
      flavor: 'bm25',
      k1: this.k1,
      b: this.b,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      records: this.records,
    };
  }

  static fromSnapshot(snap: Bm25Snapshot): Bm25Index {
    if (snap.version !== 1 || snap.flavor !== 'bm25') {
      throw new AgentError({
        code: ErrorCodes.INDEX_DB_CORRUPTED,
        message: `未知 BM25 快照版本或格式：v=${snap.version}, flavor=${snap.flavor}`,
      });
    }
    const idx = new Bm25Index({ k1: snap.k1, b: snap.b });
    idx.createdAt = snap.createdAt;
    idx.updatedAt = snap.updatedAt;
    idx.upsert(snap.records);
    // 强制同步 updatedAt 回快照时间（upsert 会覆盖）
    idx.updatedAt = snap.updatedAt;
    return idx;
  }

  async saveToFile(path: string): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    const json = JSON.stringify(this.toSnapshot());
    await fs.writeFile(path, json, 'utf-8');
  }

  static async loadFromFile(path: string): Promise<Bm25Index | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf-8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      throw new AgentError({
        code: ErrorCodes.INDEX_DB_CORRUPTED,
        message: `读取 BM25 索引失败: ${(e as Error).message}`,
      });
    }
    let snap: Bm25Snapshot;
    try {
      snap = JSON.parse(raw) as Bm25Snapshot;
    } catch (e) {
      throw new AgentError({
        code: ErrorCodes.INDEX_DB_CORRUPTED,
        message: `BM25 索引 JSON 解析失败: ${(e as Error).message}`,
      });
    }
    return Bm25Index.fromSnapshot(snap);
  }

  // ─────────── 内部辅助 ───────────

  private computeDocStats(text: string): DocStats {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { length: tokens.length, tf };
  }

  private accumulateDf(stats: DocStats): void {
    for (const term of stats.tf.keys()) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }
  }

  private retractDf(stats: DocStats): void {
    for (const term of stats.tf.keys()) {
      const cur = this.df.get(term) ?? 0;
      if (cur <= 1) this.df.delete(term);
      else this.df.set(term, cur - 1);
    }
  }

  private averageDocLength(): number {
    if (this.docStats.length === 0) return 0;
    let total = 0;
    for (const s of this.docStats) total += s.length;
    return total / this.docStats.length;
  }

  /** Robertson/Sparck-Jones 平滑 idf：log(1 + (N - df + 0.5) / (df + 0.5)) */
  private precomputeIdf(terms: readonly string[]): Map<string, number> {
    const N = this.records.length;
    const out = new Map<string, number>();
    for (const t of terms) {
      const df = this.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      out.set(t, idf);
    }
    return out;
  }
}
