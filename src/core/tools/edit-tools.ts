/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 编辑工具名单（单一事实来源）
 *
 * 会真实改动工作区文件的工具集合。此前该集合在
 * `task/loop.ts`、`tools/debug-mode-gate.ts` 以及 loop 内多处硬编码
 * filter 中各自维护，导致 append_file / delete_file 在部分链路被漏判
 * （编辑后诊断不注入、验证门可被绕过）。
 *
 * 新增编辑类工具时**只改这里**。
 */
export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'search_replace',
  'write_file',
  'append_file',
  'delete_file',
]);

/** 是否为编辑工具 */
export function isEditTool(name: string): boolean {
  return EDIT_TOOL_NAMES.has(name);
}
