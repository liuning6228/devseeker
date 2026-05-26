/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Prompt Module: `thinking_framework`（M3.14.2 · V2 核心）
 *
 * 引导模型在调用工具前做结构化思考，减少盲目工具调用。
 * 归入 L0 稳定区（不随会话变），紧接 identity 之后。
 *
 * 来源：融合 Cline objective 段的 `<thinking>` 标签要求
 * 和 Claude Code 的问题分析方法论。
 */

export const THINKING_FRAMEWORK_MODULE = [
  '# Thinking Before Acting',
  '',
  'Before using any tool, analyze the task inside <thinking> tags:',
  '',
  '<thinking>',
  '1. What does the user actually need? (Not just what they said — what problem?)',
  '2. What information do I already have? What am I missing?',
  "3. What's the simplest path to a correct solution?",
  '4. What could go wrong? How robust is this approach?',
  '</thinking>',
  '',
  'This analysis is your internal reasoning — do not echo it verbatim to the user.',
  'Focus your output on the decision and action, not the thought process.',
].join('\n');
