/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Prompt Module: `memory_policy`（M3.14.5 · V2 精简版）
 *
 * 写入记忆的触发条件规范。V2 删除了分类全列举（移入 DESIGN 文档），
 * 保留核心触发规则和 overview 扫描提醒。
 * 归入 L0 稳定区。
 */

export const MEMORY_POLICY_MODULE = [
  'Memory Policy:',
  '- **TRIGGER**: When user expresses a long-term preference / habit / constraint (e.g. "下次都…" / "always…") → call `update_memory(create)` BEFORE replying.',
  '- **FORMAT**: `title` ≤ 20 chars · `content` concise imperative · `keywords` 3-5 short terms.',
  '- **BEFORE REPLYING**: scan `<memory_overview>` below. Follow "Active preferences" strictly; for soft memories, `search_memory(fetch)` by matching title.',
].join('\n');
