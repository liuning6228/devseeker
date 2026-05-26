/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * L0 冻结快照（Phase 5 Phase B Step 4）
 *
 * 职责：session 启动时构建一次 memory/user 快照，整 session 不更新。
 * `formatForSystemPrompt()` 始终返回冻结内容。
 *
 * 临时特性开关 `featureFlag.frozenSnapshot` 允许回退旧行为。
 *
 * DESIGN-1.md §4.3 · ROADMAP.md 方案三 Phase B Step 4
 */

import type { MemoryRecord } from './types.js';
import type { MemoryManager } from './provider.js';

/** 冻结快照内容 */
export interface FrozenSnapshot {
  /** 快照时间 */
  timestamp: number;
  /** 冻结的 memory 列表 */
  memories: MemoryRecord[];
  /** 格式化后的 system prompt 块 */
  systemPromptBlock: string;
}

/** 特性开关 key */
export const FEATURE_FLAG_KEY = 'featureFlag.frozenSnapshot';

/**
 * 构建冻结快照。
 * 从 MemoryManager 读取当前所有记录 → 序列化 → 缓存。
 */
export async function buildFrozenSnapshot(
  memoryManager: MemoryManager,
): Promise<FrozenSnapshot> {
  const all = await memoryManager.list();
  const lines = renderSnapshotLines(all);
  return {
    timestamp: Date.now(),
    memories: all,
    systemPromptBlock: `<memory_overview snapshot_at="${Date.now()}">\n${lines}\n</memory_overview>`,
  };
}

/**
 * 将冻结快照格式化为系统 prompt 块。
 * 约 5-15 行，包含记忆标题和关键内容。完整检索走 L1 工具。
 */
function renderSnapshotLines(records: MemoryRecord[]): string {
  if (records.length === 0) return '  (no memories stored)';
  const lines: string[] = [];
  const hardCategories = new Set(['user_communication', 'user_behavior']);

  // 先硬约束
  const hard = records.filter((r) => hardCategories.has(r.category));
  if (hard.length > 0) {
    lines.push('## Active preferences (MUST follow immediately)');
    for (const r of hard) {
      lines.push(`- [${r.category}] ${r.title}`);
      if (r.content) lines.push(`  content: ${flatten(r.content)}`);
    }
    lines.push('');
  }

  // 其他分类只列标题，引导 L1 工具检索
  const others = records.filter((r) => !hardCategories.has(r.category));
  if (others.length > 0) {
    lines.push('## Other memories (call memory_search to fetch full content)');
    const grouped = new Map<string, MemoryRecord[]>();
    for (const r of others) {
      const list = grouped.get(r.category) ?? [];
      list.push(r);
      grouped.set(r.category, list);
    }
    for (const [cat, list] of grouped) {
      lines.push(`### ${cat} (${list.length})`);
      for (const r of list) {
        const kw = r.keywords.length > 0 ? ` | keywords: ${r.keywords.join(',')}` : '';
        lines.push(`- ${r.title}${kw}`);
      }
    }
  }

  return lines.join('\n');
}

function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 400);
}
