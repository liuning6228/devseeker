/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Memory Overview 渲染器（W7d1 · v1.8.0 向量增强）
 *
 * 职责：把 MemoryStore.list() 的结果组装成一段 system-prompt 级别的
 *       `<memory_overview>` 块，在 TaskLoop 每次 send 前注入。
 *
 * 分层策略（减 tokens + 保召回）：
 * - user_communication / user_behavior —— 行为硬约束，**完整注入 content**
 *   （例如「简短回答 ≤3 句」「做决策前先问我」必须立刻生效，不能等 LLM 自己 search）
 * - 其他分类 —— 只列 `title | keywords: ...`（LLM 按需 search_memory(fetch) 拉 content）
 * - v1.8.0 新增：若 embedder 可用，对当前 user query 做向量语义匹配，
 *   相关度 ≥ 0.30 的软记忆提升为完整 content 注入
 *
 * 输出示例：
 * ```
 * <memory_overview>
 * ## Active preferences (MUST follow immediately)
 * - [user_communication] 用户偏好简短回答
 *   content: 回答不超过 3 句，不要解释太多。
 *
 * ## Other memories (call search_memory to fetch full content)
 * ### project_tech_stack (2)
 * - 标题A | keywords: a,b
 * - 标题B
 * </memory_overview>
 * ```
 */

import type { MemoryRecord } from './types.js';
import type { Embedder } from '../index/embedder.js';
import { cosineSimilarity } from './search.js';

/** 强约束类别：完整注入 content */
const HARD_CONSTRAINT_CATEGORIES = new Set<string>([
  'user_communication',
  'user_behavior',
]);

/**
 * v1.8.0：向量增强的 Overview 注入。
 * 先用 embedder 对 userQuery 做语义匹配，将相关度 ≥ 0.30 的软记忆提升为硬约束级别。
 */
const VECTOR_OVERVIEW_THRESHOLD = 0.30;

export async function enhanceWithVectorMatch(
  records: readonly MemoryRecord[],
  userQuery: string,
  embedder?: Embedder,
): Promise<MemoryRecord[]> {
  if (!embedder || !userQuery || records.length === 0) return [...records];

  const withVec = records.filter((r) => r._embedding && r._embedding.length > 0);
  if (withVec.length === 0) return [...records];

  try {
    const queryVec = await embedder.embed([userQuery], { kind: 'query' });
    if (!queryVec.vectors.length) return [...records];
    const qv = queryVec.vectors[0];
    const enhanced: MemoryRecord[] = [...records];

    for (const r of withVec) {
      const sim = cosineSimilarity(qv, r._embedding!);
      if (sim >= VECTOR_OVERVIEW_THRESHOLD) {
        setVectorPromoted(r);
      }
    }
    return enhanced;
  } catch {
    return [...records];
  }
}

interface MemoryRecordWithFlag extends MemoryRecord {
  _vectorInjected?: boolean;
}

function isVectorPromoted(r: MemoryRecord): boolean {
  return !!(r as MemoryRecordWithFlag)._vectorInjected;
}

function setVectorPromoted(r: MemoryRecord): void {
  (r as MemoryRecordWithFlag)._vectorInjected = true;
}

/**
 * 从 experience 类记忆中选择与当前上下文最相关的 1-2 条，渲染为 `<task_context>` 块。
 *
 * 策略：取最近更新的 2 条 common_pitfalls / expert_experience / learned_skill_experience，
 * 优先返回非空 content 的记录。
 */
export function renderTaskContextSection(records: readonly MemoryRecord[]): string {
  const TASK_CONTEXT_CATEGORIES = new Set<string>([
    'expert_experience',
    'learned_skill_experience',
    'common_pitfalls_experience',
  ]);

  const candidates = records.filter(
    (r) => TASK_CONTEXT_CATEGORIES.has(r.category) && r.content && r.content.trim().length > 0,
  );
  if (candidates.length === 0) return '';

  // 取最多 2 条（已按 updatedAt 倒序，取最新的）
  const top = candidates.slice(0, 2);
  const lines: string[] = ['<task_context>'];
  lines.push('(Relevant past experiences — consider when planning your approach)');
  for (const r of top) {
    lines.push(`- [${r.category}] ${r.title}: ${flatten(r.content)}`);
  }
  lines.push('</task_context>');
  return lines.join('\n');
}

/**
 * 把若干 MemoryRecord 渲染成 `<memory_overview>` 块。
 * 若 records 为空返回空串（外部 caller 可直接不 push 到 parts）。
 *
 * v1.8.0 增强：带有 `_vectorInjected=true` 标记的记录（由 enhanceWithVectorMatch 设置）
 * 会被视同硬约束，完整注入 content。
 *
 * V2 M3.14.8 增强：新增 `taskContext` 可选段，在 active preferences 之后、
 * other memories 之前注入 `<task_context>` 块。
 */
export function renderMemoryOverview(
  records: readonly MemoryRecord[],
  taskContext?: string,
): string {
  if (records.length === 0) return '';

  const hard: MemoryRecord[] = [];
  const softByCat = new Map<string, MemoryRecord[]>();
  let hasVectorPromoted = false;
  for (const r of records) {
    const isVec = isVectorPromoted(r);
    if (HARD_CONSTRAINT_CATEGORIES.has(r.category) || isVec) {
      hard.push(r);
      if (isVec) hasVectorPromoted = true;
    } else {
      const list = softByCat.get(r.category) ?? [];
      list.push(r);
      softByCat.set(r.category, list);
    }
  }

  const lines: string[] = ['<memory_overview>'];

  if (hard.length > 0) {
    lines.push('## Active preferences (MUST follow immediately)');
    for (const r of hard) {
      const isVec = isVectorPromoted(r);
      const tag = isVec ? `[vec:${r.category}]` : `[${r.category}]`;
      lines.push(`- ${tag} ${r.title}`);
      if (r.content && r.content.trim().length > 0) {
        lines.push(`  content: ${flatten(r.content)}`);
      }
    }
    if (hasVectorPromoted) {
      lines.push('');
      lines.push('  *[vec:*] above entries were auto-promoted by vector semantic match — full content injected directly.');
    }
    lines.push('');
  }

  // V2 M3.14.8 · 可选 task_context 段（来自 experience 类记忆）
  if (taskContext && taskContext.length > 0) {
    lines.push('');
    lines.push(taskContext);
  }

  if (softByCat.size > 0) {
    lines.push('## Other memories (call search_memory to fetch full content)');
    // 稳定排序：按 category 字母序
    const cats = Array.from(softByCat.keys()).sort();
    for (const cat of cats) {
      const list = softByCat.get(cat)!;
      lines.push(`### ${cat} (${list.length})`);
      for (const r of list) {
        const kw = r.keywords.length > 0 ? ` | keywords: ${r.keywords.join(',')}` : '';
        lines.push(`- ${r.title}${kw}`);
      }
    }
  }

  lines.push('</memory_overview>');
  return lines.join('\n');
}

/** 把多行 content 压成单行（防止污染 overview 结构） */
function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 400);
}
