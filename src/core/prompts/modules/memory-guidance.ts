/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Memory 行为引导（Phase 5 Phase B Step 7）
 *
 * 在 `<memory_overview>` 块后追加引导文案。
 * 显式声明"实时写入的内容调用 memory_search 查看"。
 *
 * DESIGN-1.md §4.3 · ROADMAP.md 方案三 Phase B Step 7
 */

/** 每次注入的引导文案块 */
export const MEMORY_GUIDANCE_BLOCK = [
  '',
  '## Memory Usage Guide',
  '',
  'You have a persistent memory system. The overview above is a **frozen snapshot** taken when this session started.',
  '',
  '- To **read** real-time entries written in this session: call `memory_search`.',
  '- To **write** (add/replace/remove): call `memory`.',
  '- Memory is stored as markdown files under `.dualmind/memories/`.',
  '- Call `memory_search` before writing to avoid duplicates.',
  '',
].join('\n');

/**
 * 构建完整的 memory system prompt 块（冻结快照 + 行为引导）。
 * 注入到 system prompt 的 L2（workspace context）之后。
 */
export function buildMemorySystemBlock(frozenBlock: string): string {
  if (!frozenBlock) return '';
  return `${frozenBlock}\n${MEMORY_GUIDANCE_BLOCK}`;
}
