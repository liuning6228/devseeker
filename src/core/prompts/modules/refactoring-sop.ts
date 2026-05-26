/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Prompt Module: `refactoring_sop`（M3.14.5 · V2 精简版）
 *
 * 跨文件重构 SOP —— V2 从 5 步细则精简为 1 条核心原则。
 * 完整细则移至 L2 rules，仅在涉及跨文件重构时按需注入。
 *
 * 归入 L0 稳定区。
 */

export const REFACTORING_SOP_MODULE = [
  'Cross-file refactor: When renaming cross-file signatures, scan all references first then batch apply.',
].join('\n');
