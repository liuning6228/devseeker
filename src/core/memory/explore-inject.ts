/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Memory 模块树注入（检索差距弥补计划 T3）
 *
 * 对齐 Qoder 「知识模块树预分解」：给出与当前任务相关的记忆分类骨架
 * （`- [category] title` 标题行，无内容），让 LLM 在本轮就知道"哪些记忆域
 * 可能有关"，需要详情时再 `memory_search(fetch)` 二次取。
 *
 * 设计：
 * - 复用 searchMemories 的 shallow 打分（title +0.5 / keywords +0.4 / content +0.1）
 * - 按 category 聚合、组内按得分降序；titles 上限可配（默认 8）
 * - 纯同步函数（shallow 为同步路径），零 IO，可单测
 * - 无命中 → undefined（零注入，不占 token）
 */

import type { MemoryRecord } from './types.js';
import { searchMemories } from './search.js';

export interface MemoryTreeOptions {
  /** 最多输出标题数，默认 8 */
  maxTitles?: number;
  /** shallow 命中最低得分（0~1），默认 0.2 */
  minScore?: number;
}

/**
 * 构建任务相关的记忆树骨架块；无相关命中时返回 undefined。
 *
 * @param query 任务关键词（字符串会被切词，或直接传词数组）
 */
export function buildMemoryTreeBlock(
  records: readonly MemoryRecord[],
  query: string | string[],
  opts?: MemoryTreeOptions,
): string | undefined {
  const maxTitles = opts?.maxTitles ?? 8;
  const minScore = opts?.minScore ?? 0.2;
  // 字符串切词 / 数组透传都统一过滤短词（<2 字符），避免单字符命中
  // keywords 子串（如 'a' 命中 'auth'）造成假阳性
  const keywords = (Array.isArray(query) ? query : query.split(/[\s,，、/|]+/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  if (keywords.length === 0 || records.length === 0) return undefined;

  const output = searchMemories(records, {
    depth: 'shallow',
    query: keywords.join(' '),
    keywords,
    limit: 50,
  });
  if (!('hits' in output)) return undefined;
  const hits = output.hits.filter((h) => h.score >= minScore);
  if (hits.length === 0) return undefined;

  // 按 category 聚合（保持稳定顺序），组内按得分降序
  const byCat = new Map<string, Array<{ title: string; score: number }>>();
  for (const h of hits) {
    const arr = byCat.get(h.record.category) ?? [];
    arr.push({ title: h.record.title, score: h.score });
    byCat.set(h.record.category, arr);
  }

  const lines = [
    '<memory_tree>',
    '(与当前任务相关的记忆分类骨架：标题仅为提示，需要详情时用 memory_search 按标题 fetch)',
  ];
  let count = 0;
  for (const [cat, entries] of [...byCat.entries()].sort()) {
    entries.sort((a, b) => b.score - a.score);
    for (const e of entries) {
      if (count >= maxTitles) break;
      lines.push(`- [${cat}] ${e.title}`);
      count++;
    }
    if (count >= maxTitles) break;
  }
  lines.push('</memory_tree>');
  return count === 0 ? undefined : lines.join('\n');
}