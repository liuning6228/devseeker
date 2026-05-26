/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Fork 子代理机制（Phase 5 Phase B Step 6）
 *
 * 当 `mode='fork'` 时，子代理复用父进程的 MessageHistory 快照（共享 prompt cache）。
 * 当 `mode='fresh'`（默认）时，走当前独立上下文路径。
 * inherit 模式在 V1 不做（⏳ 推迟）。
 *
 * 安全：递归保护 —— 子代理 system prompt 嵌入 `<FORK_BOILERPLATE_TAG>`，
 *       嵌套 fork 检测到后直接拒绝并返回错误，不做静默降级。
 *
 * DESIGN-1.md §4.3 · ROADMAP.md 方案一 Phase B Step 6
 */

import type { Message } from '../../providers/types.js';

/** Fork 警戒标签 —— 子代理 system prompt 中嵌入此标记 */
export const FORK_BOILERPLATE_TAG = '<FORK_BOILERPLATE_TAG>';

/**
 * 检测是否已在 fork 上下文中。
 * 若 systemPrompt 中包含 FORK_BOILERPLATE_TAG，则拒绝嵌套 fork。
 */
export function isInsideFork(systemPrompt: string): boolean {
  return systemPrompt.includes(FORK_BOILERPLATE_TAG);
}

/**
 * 创建 fork 快照：复制当前 MessageHistory 的消息列表。
 * 快照是浅复制——每条消息的 content 引用不变，但数组是新数组。
 */
export function createForkSnapshot(messages: Message[]): Message[] {
  return messages.map((m) => ({ ...m }));
}

/**
 * 构建带警戒标记的 fork system prompt。
 * 在原 prompt 末尾追加 FORK_BOILERPLATE_TAG 和深度警告。
 */
export function buildForkSystemPrompt(
  basePrompt: string,
  depth: number,
  maxDepth: number,
): string {
  const lines = [
    basePrompt.replace(/\n+$/, ''),
    '',
    FORK_BOILERPLATE_TAG,
    `⚠️ You are inside a fork (depth ${depth}/${maxDepth}).`,
    'Do NOT fork again — nested forks are forbidden.',
    'If you need to delegate, use fresh mode instead.',
    '',
  ];
  return lines.join('\n');
}
