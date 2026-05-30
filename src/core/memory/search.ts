/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * MemorySearch —— 四种深度的记忆检索（W4 批次 2）
 *
 * 深度定义（对齐   search_memory 工具语义）：
 * - fetch   : 按 exact title 命中精确记忆（max 5 条）
 * - shallow : 按多个 keywords 在 title/keywords/content 做关键词匹配
 * - deep    : 在 shallow 基础上再融合 category 匹配 + 模糊标题
 * - explore : 返回指定分类树下的记忆标题（不返回内容），供 LLM 二次 fetch
 *
 * 打分（shallow / deep）：
 * - 每个关键词在 title 命中 +0.5，在 keyword 命中 +0.4，在 content 命中 +0.1
 * - 每个匹配向量归一到 0~1 区间，再取 hits 总分 / 关键词数
 * - deep 模式里 category 命中额外 +0.2 封顶
 */

import type { MemoryRecord, MemoryHit, SearchDepth } from './types.js';
import { CATEGORY_GROUPS } from './categories.js';
import type { MemoryCategory } from './categories.js';
import { AgentError, ErrorCodes } from '../errors/index.js';
import type { Embedder } from '../index/embedder.js';

export interface SearchInput {
  depth: SearchDepth;
  /** fetch: 逗号分隔的 title 列表；explore: 逗号分隔的 path 列表；shallow/deep: 自由文本 */
  query: string;
  keywords?: string[];
  /** 可选：限定类别（shallow/deep 才生效） */
  category?: string;
  /** 最大命中数（fetch 默认 5，shallow 默认 10，deep 默认 20，explore 默认 30） */
  limit?: number;
}

export interface ExploreResult {
  kind: 'explore';
  /** 当前路径下的子分类列表 */
  groups: string[];
  /** 当前路径下的记忆标题 + id */
  titles: Array<{ id: string; title: string; category: MemoryCategory }>;
}

export type SearchOutput = { kind: 'hits'; hits: MemoryHit[] } | ExploreResult;

/** 主入口 */
export function searchMemories(
  records: readonly MemoryRecord[],
  input: SearchInput,
  embedder?: Embedder,
): SearchOutput | Promise<SearchOutput> {
  switch (input.depth) {
    case 'fetch':
      return { kind: 'hits', hits: fetchByTitle(records, input) };
    case 'shallow':
      return { kind: 'hits', hits: shallowSearch(records, input) };
    case 'deep':
      return deepSearchWithVector(records, input, embedder);
    case 'explore':
      return exploreTree(records, input);
    default:
      throw new AgentError({
        code: ErrorCodes.MEMORY_SEARCH_INVALID_DEPTH,
        message: `非法 depth：${input.depth}`,
      });
  }
}

// ─────────── fetch ───────────

function fetchByTitle(records: readonly MemoryRecord[], input: SearchInput): MemoryHit[] {
  const titles = splitCsv(input.query);
  const limit = input.limit ?? 5;
  if (titles.length === 0) return [];
  const out: MemoryHit[] = [];
  for (const r of records) {
    if (titles.some((t) => equalsIgnoreCase(t, r.title))) {
      out.push({ record: r, score: 1, matchedOn: ['title'] });
    }
  }
  return out.slice(0, limit);
}

// ─────────── shallow ───────────

function shallowSearch(records: readonly MemoryRecord[], input: SearchInput): MemoryHit[] {
  const kws = prepareKeywords(input);
  const limit = input.limit ?? 10;
  if (kws.length === 0) return [];
  const scored: MemoryHit[] = [];
  for (const r of records) {
    if (input.category && r.category !== input.category) continue;
    const hit = scoreRecord(r, kws, false);
    if (hit) scored.push(hit);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ─────────── deep (关键词 + 向量) ───────────

async function deepSearchWithVector(
  records: readonly MemoryRecord[],
  input: SearchInput,
  embedder?: Embedder,
): Promise<SearchOutput> {
  const kws = prepareKeywords(input);
  const limit = input.limit ?? 20;
  const scored: MemoryHit[] = [];

  // 1. 关键词匹配（原有的 deep 逻辑）
  for (const r of records) {
    if (input.category && r.category !== input.category) continue;
    const hit = scoreRecord(r, kws, true);
    if (!hit) continue;
    if (input.category && r.category === input.category) {
      hit.score = Math.min(1, hit.score + 0.2);
      if (!hit.matchedOn.includes('category')) hit.matchedOn.push('category');
    }
    scored.push(hit);
  }

  // 2. 向量检索增强（v1.8.0）：当 embedder 可用时，对已有 _embedding 的记录做余弦相似度
  if (embedder && input.query) {
    const recordsWithVec = records.filter((r) => r._embedding && r._embedding.length > 0);
    if (recordsWithVec.length > 0) {
      try {
        const queryVec = await embedder.embed([input.query], { kind: 'query' });
        if (queryVec.vectors.length > 0) {
          const qv = queryVec.vectors[0];
          for (const r of recordsWithVec) {
            if (input.category && r.category !== input.category) continue;
            const sim = cosineSimilarity(qv, r._embedding!);
            if (sim >= VECTOR_SIM_THRESHOLD) {
              // 取关键词得分与向量得分的 max（保证关键词精确匹配不丢失）
              const existing = scored.find((h) => h.record.id === r.id);
              if (existing) {
                if (sim > existing.score) {
                  existing.score = sim;
                  if (!existing.matchedOn.includes('vector')) existing.matchedOn.push('vector');
                }
              } else {
                scored.push({
                  record: r,
                  score: sim,
                  matchedOn: ['vector'],
                });
              }
            }
          }
        }
      } catch {
        // embedder 调用失败 → 静默跳过向量分支（已有关键词结果兜底）
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return { kind: 'hits', hits: scored.slice(0, limit) };
}

/**
 * 向量余弦相似度（v1.8.0）。
 * 两个等长的 number[] 做点积 / (|a| * |b|)。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 向量相似度阈值：≥0.35 认为语义相关（经验值） */
const VECTOR_SIM_THRESHOLD = 0.35;

// ─────────── explore ───────────

function exploreTree(records: readonly MemoryRecord[], input: SearchInput): ExploreResult {
  const paths = splitCsv(input.query);
  const limit = input.limit ?? 30;
  const titles: ExploreResult['titles'] = [];
  const groupsSet = new Set<string>();

  // 无路径 → 返回所有顶层分组
  if (paths.length === 0 || paths.every((p) => !p.trim())) {
    Object.keys(CATEGORY_GROUPS).forEach((g) => groupsSet.add(g));
    return { kind: 'explore', groups: Array.from(groupsSet), titles: [] };
  }

  for (const p of paths) {
    const segments = p.split('-').map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) continue;

    const root = segments[0];
    const categories = CATEGORY_GROUPS[root];
    if (!categories) continue;

    if (segments.length === 1) {
      // 只有大类：列出该大类下所有子类别名 + 记忆标题
      for (const c of categories) groupsSet.add(`${root}-${c}`);
      for (const r of records) {
        if ((categories as readonly string[]).includes(r.category)) {
          titles.push({ id: r.id, title: r.title, category: r.category });
        }
      }
    } else {
      // 精确到具体 category
      const cat = segments[1];
      if (!(categories as readonly string[]).includes(cat)) continue;
      for (const r of records) {
        if (r.category === cat) {
          titles.push({ id: r.id, title: r.title, category: r.category });
        }
      }
    }
  }
  return {
    kind: 'explore',
    groups: Array.from(groupsSet).sort(),
    titles: titles.slice(0, limit),
  };
}

// ─────────── scoring helpers ───────────

function scoreRecord(
  r: MemoryRecord,
  keywords: string[],
  deep: boolean,
): MemoryHit | undefined {
  const titleLc = r.title.toLowerCase();
  const contentLc = r.content.toLowerCase();
  const kwLc = r.keywords.map((k) => k.toLowerCase());
  let total = 0;
  const matched = new Set<'title' | 'content' | 'keywords' | 'category'>();
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    let best = 0;
    if (titleLc.includes(k)) {
      best = Math.max(best, 0.5);
      matched.add('title');
    }
    if (kwLc.some((x) => x === k || x.includes(k) || k.includes(x))) {
      best = Math.max(best, 0.4);
      matched.add('keywords');
    }
    if (contentLc.includes(k)) {
      best = Math.max(best, 0.1);
      matched.add('content');
    }
    total += best;
  }
  // 归一：按关键词数平均，再乘 2（因为单 kw 最大 0.5）
  const score = Math.min(1, (total / Math.max(1, keywords.length)) * 2);
  if (score <= 0) return undefined;
  // deep 模式的模糊标题：若关键词整体拼接能命中一部分标题连续字符，加 0.1
  if (deep) {
    const joined = keywords.map((k) => k.toLowerCase()).join(' ');
    if (joined.length >= 3 && titleLc.includes(joined)) {
      matched.add('title');
    }
  }
  return {
    record: r,
    score,
    matchedOn: Array.from(matched),
  };
}

function prepareKeywords(input: SearchInput): string[] {
  const kws = Array.isArray(input.keywords) ? input.keywords : [];
  const fromQuery = input.query
    .split(/[\s,，、/|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const merged = [...kws, ...fromQuery].map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of merged) {
    const lc = m.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    out.push(m);
  }
  return out.slice(0, 5);
}

function splitCsv(s: string): string[] {
  if (typeof s !== 'string') return [];
  return s
    .split(/[,，]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
