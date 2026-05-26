/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Relevance 提取算法（W8.9 / DESIGN §M12.5）
 *
 * 目标：当 fetch_content 传入 query 且内容超出 maxLength 时，
 * 选取与 query 最相关的段落按原文顺序拼接，段落间插入 "\n\n[…]\n\n" 标识跳过。
 *
 * 双策略：
 * 1. **语义策略**（embedder 可用）：
 *    切段 → embed(query + paragraphs) → 余弦相似度 → Top-K 原序拼接
 * 2. **关键词策略**（embedder 不可用时 fallback）：
 *    tf-idf 轻量打分（query tokens → 每段 tf × log(N / df) 求和），按分数排序
 *
 * 非目标：
 * - 不做跨语言分词（中英文用简单的 /\s+/ + 去标点，够用）
 * - 不做向量缓存（单次抓取范围内，重算成本可接受）
 * - 不做流式（一次性处理，长文在 5MB 上限内可控）
 *
 * 集成点：`fetch_content.ts`。当用户未传 query 或内容本身不超长时，维持原 MVP 行为。
 */

import type { Embedder } from '../index/embedder.js';

/** 段落的最大长度（字符）。超出会被二次切分。 */
const DEFAULT_CHUNK_MAX = 1200;
/** 段落的最小长度（字符）。短于此值的相邻段落合并。 */
const DEFAULT_CHUNK_MIN = 120;
/** 段落间的跳过标记 */
export const SKIP_MARKER = '\n\n[…]\n\n';

export interface ExtractRelevantOptions {
  query: string;
  /** 输出上限（字符）；包含 SKIP_MARKER 本身的长度 */
  maxLength: number;
  /** 可选：embedder 注入。存在 → 语义策略；缺省 → 关键词 fallback */
  embedder?: Embedder;
  /** 切段最大长度（字符），默认 1200 */
  chunkMax?: number;
  /** 切段最小长度（字符），默认 120 */
  chunkMin?: number;
}

export interface ExtractRelevantResult {
  /** 裁剪后的文本（段落按原文顺序，用 SKIP_MARKER 分隔跳过部分） */
  content: string;
  /** 是否发生裁剪（false 表示原文已在 maxLength 内） */
  truncated: boolean;
  /** 选中的段落数量 */
  selected: number;
  /** 原段落总数 */
  totalChunks: number;
  /** 本次所用策略（用于诊断） */
  strategy: 'semantic' | 'keyword' | 'noop';
}

/**
 * 按 query 提取相关段落。
 * - 若原文已 ≤ maxLength 或 query 空 → noop 返回原文。
 */
export async function extractRelevant(
  content: string,
  opts: ExtractRelevantOptions,
): Promise<ExtractRelevantResult> {
  const { maxLength } = opts;
  const query = (opts.query ?? '').trim();

  if (!query || content.length <= maxLength) {
    return {
      content,
      truncated: false,
      selected: 0,
      totalChunks: 0,
      strategy: 'noop',
    };
  }

  const chunkMax = opts.chunkMax ?? DEFAULT_CHUNK_MAX;
  const chunkMin = opts.chunkMin ?? DEFAULT_CHUNK_MIN;
  const chunks = splitChunks(content, chunkMax, chunkMin);
  if (chunks.length === 0) {
    return {
      content: content.slice(0, maxLength),
      truncated: true,
      selected: 0,
      totalChunks: 0,
      strategy: 'noop',
    };
  }

  // 打分
  let scored: Array<{ idx: number; score: number }>;
  let strategy: 'semantic' | 'keyword';
  if (opts.embedder) {
    try {
      scored = await scoreBySemantic(query, chunks, opts.embedder);
      strategy = 'semantic';
    } catch {
      // embedder 失败 → 回落到关键词策略（保可用性）
      scored = scoreByKeyword(query, chunks);
      strategy = 'keyword';
    }
  } else {
    scored = scoreByKeyword(query, chunks);
    strategy = 'keyword';
  }

  // 按分数降序，贪心选段直到合计 ≤ maxLength（考虑连接符开销）
  const sortedDesc = scored.slice().sort((a, b) => b.score - a.score);
  const chosen = new Set<number>();
  let used = 0;
  for (const s of sortedDesc) {
    const len = chunks[s.idx]!.length;
    const sepCost = chosen.size > 0 ? SKIP_MARKER.length : 0;
    if (used + len + sepCost > maxLength) {
      // 跳过过大的段落，继续尝试更小的（允许贪心乱序）
      continue;
    }
    chosen.add(s.idx);
    used += len + sepCost;
    if (used >= maxLength * 0.98) break;
  }

  // 按原文顺序拼接，不相邻段落间插入 SKIP_MARKER
  const ordered = Array.from(chosen).sort((a, b) => a - b);
  const parts: string[] = [];
  let prev = -1;
  for (const idx of ordered) {
    if (prev !== -1 && idx !== prev + 1) parts.push(SKIP_MARKER);
    parts.push(chunks[idx]!);
    prev = idx;
  }
  // 若选段不是从 0 开始 / 不是到末尾 → 前后也加 marker
  if (ordered.length > 0) {
    if (ordered[0]! > 0) parts.unshift(SKIP_MARKER);
    if (ordered[ordered.length - 1]! < chunks.length - 1) parts.push(SKIP_MARKER);
  }

  let joined = parts.join('');
  if (joined.length > maxLength) {
    joined = joined.slice(0, maxLength);
  }

  return {
    content: joined,
    truncated: true,
    selected: ordered.length,
    totalChunks: chunks.length,
    strategy,
  };
}

// ───────────────────────── chunk 切分 ─────────────────────────

/**
 * 先按 markdown 标题（#/##/###）分节，节内按空行切段落；超长段落按字符窗口硬切。
 * 过短的段落与下一段合并。
 */
export function splitChunks(
  text: string,
  chunkMax: number = DEFAULT_CHUNK_MAX,
  chunkMin: number = DEFAULT_CHUNK_MIN,
): string[] {
  if (!text.trim()) return [];

  // Step 1: 按标题切节（标题本身作为下一节的起首行保留）
  const sections: string[] = [];
  const lines = text.split(/\r?\n/);
  let buf: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line) && buf.length > 0) {
      sections.push(buf.join('\n'));
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.length > 0) sections.push(buf.join('\n'));

  // Step 2: 节内按空行切段落
  const paras: string[] = [];
  for (const sec of sections) {
    const byBlank = sec.split(/\n\s*\n+/);
    for (const p of byBlank) {
      const t = p.trim();
      if (t) paras.push(t);
    }
  }

  // Step 3: 超长段落按字符窗口硬切
  const expanded: string[] = [];
  for (const p of paras) {
    if (p.length <= chunkMax) {
      expanded.push(p);
      continue;
    }
    for (let i = 0; i < p.length; i += chunkMax) {
      expanded.push(p.slice(i, i + chunkMax));
    }
  }

  // Step 4: 过短段落与下一段合并（避免碎片）
  const merged: string[] = [];
  for (const p of expanded) {
    if (merged.length > 0 && merged[merged.length - 1]!.length < chunkMin) {
      const prev = merged.pop()!;
      const combined = prev + '\n\n' + p;
      if (combined.length <= chunkMax * 1.5) {
        merged.push(combined);
      } else {
        merged.push(prev);
        merged.push(p);
      }
    } else {
      merged.push(p);
    }
  }

  return merged;
}

// ───────────────────────── 语义打分（embedder） ─────────────────────────

async function scoreBySemantic(
  query: string,
  chunks: string[],
  embedder: Embedder,
): Promise<Array<{ idx: number; score: number }>> {
  // 一次性 batch：query + 所有 chunks
  const inputs = [query, ...chunks];
  const { vectors } = await embedder.embed(inputs);
  if (vectors.length !== inputs.length) {
    throw new Error('embedder returned mismatched vectors count');
  }
  const qVec = vectors[0]!;
  return chunks.map((_, idx) => ({
    idx,
    score: cosine(qVec, vectors[idx + 1]!),
  }));
}

/** 余弦相似度；任一零向量返回 0 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ───────────────────────── 关键词打分（tf-idf 简易版） ─────────────────────────

/**
 * query tokens 在每段的 tf × idf 求和作为分数。
 * 对中文：按单字作为 token（与英文用 /\s+/ 互补）。
 * 最小依赖：无外部 NLP 库。
 */
export function scoreByKeyword(
  query: string,
  chunks: string[],
): Array<{ idx: number; score: number }> {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) {
    return chunks.map((_, idx) => ({ idx, score: 0 }));
  }

  // df: 每 token 出现在多少段
  const df = new Map<string, number>();
  const chunkTokens = chunks.map((c) => {
    const arr = tokenize(c);
    const seen = new Set<string>();
    for (const t of arr) {
      if (!seen.has(t)) {
        seen.add(t);
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
    return arr;
  });

  const N = chunks.length;
  const unique = new Set(qTokens);
  return chunkTokens.map((tokens, idx) => {
    if (tokens.length === 0) return { idx, score: 0 };
    // tf per query token
    const tf = new Map<string, number>();
    for (const t of tokens) {
      if (unique.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    let score = 0;
    for (const [tok, count] of tf) {
      const dfi = df.get(tok) ?? 0;
      if (dfi === 0) continue;
      // +1 平滑，避免 log(N/N)=0 让高频词贡献归零
      const idf = Math.log((N + 1) / (dfi + 1)) + 1;
      score += (count / tokens.length) * idf;
    }
    return { idx, score };
  });
}

/**
 * 极简 tokenizer：
 * - 英文 / 数字：按 /\s+/ 切，去标点，小写
 * - 中文：按单字（CJK Unified Ideographs 范围）
 * - 其他符号丢弃
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  // 先抽中文单字
  const cjk = text.match(/[\u4e00-\u9fff]/g);
  if (cjk) out.push(...cjk);
  // 再抽英文/数字 token（≥ 2 字符）
  const asciiTokens = text
    .toLowerCase()
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 2);
  out.push(...asciiTokens);
  return out;
}
