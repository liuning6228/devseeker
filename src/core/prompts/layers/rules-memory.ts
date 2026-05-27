/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * L2 Workspace Rules & Memory Overview Layer（DESIGN §M3.6 · W3.6 · V2 M3.14.8）
 *
 * 本层承载「项目规则 + model_decision 索引 + memory_overview（含 task_context）」——
 * 随 workspace 规则文件变动、memory 增删改、activeFile glob 命中而变。
 *
 * V2 增强（M3.14.8）：memory_overview 新增 `<task_context>` 可选段，
 * 从 experience 类记忆中选择最相关的 1-2 条注入。
 *
 * 缓存边界：当 rules/memory 不变时 L2 字节级稳定；
 * 改 rule 文件或写新 memory 时，L2 本轮失效，但 L0+L1 前缀依然命中。
 *
 * 设计要点：
 * - rules 必须已经经过 selector 的稳定排序（kind → priority desc → name asc）
 * - memories 来自 MemoryStore.list()（按 updatedAt 倒序）——任何 memory 变动都会
 *   重新排列顺序 → L2 本轮必失效，这是**刻意**的语义正确性（新记忆优先）。
 *   若要追求极致 cache 命中，可在本层内对 memories 再按 id 排序，但会让 LLM 看到
 *   过期的优先级，弊大于利。当前实现不做二次排序。
 */

import { renderForSystemPrompt, listModelDecisionRules } from '../../rules/selector.js';
import type { Rule } from '../../rules/types.js';
import { renderMemoryOverview } from '../../memory/overview.js';
import type { MemoryRecord } from '../../memory/types.js';

export interface L2RulesMemoryInput {
  /** selector 已过滤 + 排序好的规则列表（always_on + 命中 glob 的） */
  selectedRules: readonly Rule[];
  /** 全部规则（用于提取 model_decision 清单） */
  allRules: readonly Rule[];
  /** MemoryStore.list() 的输出 */
  memories: readonly MemoryRecord[];
  /**
   * V2 M3.14.8 · 可选的 task_context 块文本。
   * 由上层从 experience 类记忆中选择最相关的 1-2 条、调用
   * renderTaskContextSection() 生成后传入。
   * 空串/undefined 时不注入，保持向后兼容。
   */
  taskContext?: string;
}

/**
 * 构建 L2 层：项目规则 + model_decision 清单 + memory_overview（含可选 task_context）。
 *
 * 各子段为空时自动省略；全空时返回空字符串（调用方据此决定是否拼入）。
 */
export function buildL2RulesMemory({
  selectedRules,
  allRules,
  memories,
  taskContext,
}: L2RulesMemoryInput): string {
  const parts: string[] = [];

  // ─── Rules 段（V2 M3.14.5 ·含规则应用引导） ───
  if (selectedRules.length > 0) {
    const rulesBlock = renderForSystemPrompt(selectedRules.slice());
    if (rulesBlock) parts.push(rulesBlock);

    // V2 M3.14.5 · Rule 应用引导：仅在选中规则时追加
    parts.push(
      [
        '# Rule Application Guidelines',
        '- Apply rules that clearly address the current context.',
        '- If two rules conflict, the more specific one takes precedence.',
        '- If a rule is only tangentially related, you may skip it.',
        '- When unsure whether a rule applies, fetch its full content to verify.',
      ].join('\n'),
    );
  }

  // ─── model_decision 索引（引导 LLM 按需 fetch_rules） ───
  const mdList = listModelDecisionRules(allRules.slice());
  if (mdList.length > 0) {
    parts.push(
      [
        '# Available model_decision Rules',
        'The following rules are NOT auto-loaded. Call `fetch_rules(rule_names=[...])` when their topic is relevant:',
        ...mdList.map((r) => `- ${r.name}${r.description ? ` — ${r.description}` : ''}`),
      ].join('\n'),
    );
  }

  // ─── memory_overview（硬约束 + task_context + 软记忆标题） ───
  const overview = renderMemoryOverview(memories, taskContext);
  if (overview) parts.push(overview);

  return parts.join('\n\n');
}
