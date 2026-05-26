/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * L0 Identity & Protocol Layer（DESIGN §M3.6 · W3.6 Cache Priority Ordering · V2 M3.14）
 *
 * 本层为 System Prompt 的最外层稳定前缀，**永不随会话/轮次变化**：
 * - AI 身份声明（三段式）
 * - 思考框架（<thinking> 先思再行）
 * - 输出风格（效率 + 引用规约）
 * - 通用工具契约（精简版）
 * - 行为协议
 * - 中文注释/文档规范
 * - 记忆策略
 * - web_research 六条纪律
 * - 模型 Variant 专属后缀（M3.14.6 · 动态注入，按 modelId 选择）
 *
 * V2 变更（M3.14）：新增 thinking-framework + output-style 模块 + model variant 后缀，
 * 精简了 tool-contracts / general-behavior / refactoring-sop / memory-policy。
 *
 * 缓存边界：只要产品版本（工具契约）与身份文案不变，L0 的 SHA 永远一致 →
 * Prompt Cache 的前缀命中从 L0 起算。切换 Mode / Rules / Memory 都不应动到这里。
 *
 * 注意：model variant l0Suffix 是 modelId 驱动的，切换 model 会导致 L0 变化
 * 并破坏缓存前缀，但这正是期望的语义（不同模型需要不同的专属指导）。
 * 如果用户在同一会话中切换模型（罕见），缓存命中率将会降低，但正确性优先。
 */

import { WEB_RESEARCH_PROMPT_MODULE } from '../web-research.js';
import {
  AGENT_IDENTITY_MODULE,
  THINKING_FRAMEWORK_MODULE,
  OUTPUT_STYLE_MODULE,
  TOOL_CONTRACTS_MODULE,
  GENERAL_BEHAVIOR_MODULE,
  REFACTORING_SOP_MODULE,
  I18N_COMMENTS_MODULE,
  MEMORY_POLICY_MODULE,
} from '../modules/index.js';
import { getVariantL0Suffix } from '../variants/index.js';

/**
 * L0 稳定区拼接顺序（V2 · M3.14）：
 *
 *   1. agent-identity         —— 三段式身份 + 角色 + 方法论
 *   2. thinking-framework     —— <thinking> 先思再行（V2 新增）
 *   3. output-style           —— 输出效率 + markdown 引用（V2 新增）
 *   4. tool-contracts         —— 工具契约（V2 精简）
 *   5. general-behavior       —— 通用行为（V2 精简）
 *   6. refactoring-sop        —— 跨文件重构 SOP（V2 精简为 1 条）
 *   7. i18n-comments          —— 中文注释/文档规范
 *   8. memory-policy          —— 记忆策略（V2 精简）
 *   9. [variant l0Suffix]     —— 模型专属后缀（按 modelId 注入，generic 时空）
 *  10. web-research           —— 联网纪律
 *
 * 排序原则：身份塑造 → 思考引导 → 输出风格 → 工具契约 → 行为约束 → 后置策略 → 模型专属 → 联网。
 * 第 1-3 段是「塑造模型行为」，第 4-8 段是「约束模型行为」。
 * 第 9 段仅在非 generic variant 时出现。
 */
export const BASE_L0_MODULES = [
  AGENT_IDENTITY_MODULE,
  THINKING_FRAMEWORK_MODULE,
  OUTPUT_STYLE_MODULE,
  TOOL_CONTRACTS_MODULE,
  GENERAL_BEHAVIOR_MODULE,
  REFACTORING_SOP_MODULE,
  I18N_COMMENTS_MODULE,
  MEMORY_POLICY_MODULE,
];

/** 基础 L0（不含 variant 后缀和 web-research），用于测试断言 */
export const DEFAULT_SYSTEM_PROMPT = [...BASE_L0_MODULES].join('\n\n');

/**
 * L0 完整拼接：base + 可选 variant l0Suffix + web-research 模块。
 *
 * modelId 为空或 generic variant 时 l0Suffix 为空串，此时输出与前缀缓存兼容。
 */
export function buildL0Identity(modelId?: string): string {
  const parts = [...BASE_L0_MODULES];
  const suffix = modelId ? getVariantL0Suffix(modelId) : '';
  if (suffix) parts.push(suffix);
  parts.push(WEB_RESEARCH_PROMPT_MODULE);
  return parts.join('\n\n');
}
