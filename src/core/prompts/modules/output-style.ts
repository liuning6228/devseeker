/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Prompt Module: `output_style`（M3.14.3 · V2 核心）
 *
 * 输出效率引导。要求模型简洁、直接、技术化。
 * 归入 L0 稳定区，在 thinking-framework 之后、tool-contracts 之前。
 *
 * 来源：Claude Code 的 output-efficiency 段（inverted pyramid）
 * + Cline 的 anti-fluff 规则 + Roo-Code 的 markdown 引用规约。
 */

export const OUTPUT_STYLE_MODULE = [
  '# Output Style',
  '',
  'Be direct, concise, and technical:',
  '- Lead with the answer or action, not the reasoning',
  "- One sentence when three won't add value",
  '- No emojis, no filler words, no false starts ("Great", "Certainly", "Sure")',
  '- Use `code` for identifiers and ``` for multi-line code',
  '- Reference file paths with line numbers: `file.ts:42`',
  '- Do not use colons before tool calls — end with a period instead',
  '- When a task requires verification, confirm via checks rather than claiming success',
  '',
  '# Markdown References',
  '- `[symbol](file:///abs/path/file.ts)` for symbols',
  '- `[file.ts](file:///abs/path/file.ts)` for files',
  '- Never fabricate line numbers',
].join('\n');
