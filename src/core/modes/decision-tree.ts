/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * shouldDeepPlan 决策树（Phase 5 Phase A Step 1）
 *
 * 自动触发 Plan 模式的三级决策：auto_plan / suggest_plan / no_plan。
 *
 * 设计来源：
 * - Cline EnterPlanMode 决策树（170 行 Prompt，7 条触发场景 + 正反例）
 * - 本方案：做成纯函数（输入 user message → 输出决策），副作用由调用方处理
 * - 极低误报率：no_plan 保守 ≥95%
 *
 * DESIGN-1.md §4.2 · ROADMAP.md 方案二 Phase A Step 1
 */

/** 决策结果 */
export type PlanDecision = 'auto_plan' | 'suggest_plan' | 'no_plan';

/** 特征提取结果 */
export interface MessageFeatures {
  /** 显式规划意图："帮我设计/规划/方案/架构" */
  hasExplicitPlanIntent: boolean;
  /** 架构关键词命中数（refactor/重构/架构/迁移/redesign/migration/observability） */
  keywordHits: number;
  /** 用户消息中引用的文件路径数量 */
  fileRefCount: number;
  /** 用户消息 token 数（估算） */
  tokenCount: number;
  /** 是否为架构性提问（"怎么做"/"什么方案"/"What's the best approach"） */
  hasArchitectureQuery: boolean;
}

/** 架构关键词（中英双语） */
const ARCH_KEYWORDS = [
  'refactor', '重构',
  '架构', 'architect', 'architecture',
  '迁移', 'migration', 'migrate',
  'redesign', '重塑',
  'observability', '可观测',
  '设计', 'design',
  '规划', 'plan',
];

/** 显式规划意图关键词 */
const EXPLICIT_PLAN_INTENT = [
  '帮我设计', '帮我规划',
  '设计方案', '规划方案',
  'design', 'plan for',
  'architecture for',
  'how should I',
  'what approach',
  'compare options',
];

/** 架构性提问关键词 */
const ARCHITECTURE_QUERY = [
  '怎么做', 'how to',
  '什么方案', 'what approach',
  'best', 'choose',
  '方案对比', 'comparison',
  '哪个好', 'which',
];

/**
 * 从 user message 提取特征。
 */
export function extractFeatures(msg: string): MessageFeatures {
  const lower = msg.toLowerCase();

  const hasExplicitPlanIntent = EXPLICIT_PLAN_INTENT.some((kw) => lower.includes(kw));

  const keywordHits = ARCH_KEYWORDS.reduce((count, kw) => {
    return count + (lower.includes(kw) ? 1 : 0);
  }, 0);

  // 文件引用：`/path/file.ts` 或 `path/file.ts:L10` 模式
  const fileRefs = msg.match(/[\w\-./]+\.(ts|js|tsx|jsx|py|go|rs|java|kt|swift|css|scss):?\d*/g);
  const fileRefCount = fileRefs ? fileRefs.length : 0;

  // 粗略 token 估算（按英文 4 char/token，中文 2 char/token）
  const cjkCount = (msg.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const asciiCount = msg.length - cjkCount;
  const tokenCount = Math.ceil(asciiCount / 4) + Math.ceil(cjkCount / 2);

  const hasArchitectureQuery = ARCHITECTURE_QUERY.some((kw) => lower.includes(kw));

  return {
    hasExplicitPlanIntent,
    keywordHits,
    fileRefCount,
    tokenCount,
    hasArchitectureQuery,
  };
}

/**
 * 决策树主入口。
 *
 * 规则（全量保留 Cline EnterPlanMode 7 条触发场景）：
 *
 * auto_plan（无需用户确认，直接注入 switch_mode）：
 *   - 用户说了"帮我设计/规划/方案"（显式意图）
 *   - 架构关键词 ≥ 3
 *   - 多文件引用 ≥ 5 + 架构关键词 ≥ 1
 *
 * suggest_plan（需用户确认，对应 Cline EnterPlanMode 建议）：
 *   - 文件引用 ≥ 3 + token ≥ 100 + 架构关键词 ≥ 1
 *   - 或：架构性提问 + token ≥ 150
 *
 * no_plan（不触发）：
 *   - 单文件修改、已知根因 bug fix、简单功能
 *   - 研究探索（建议用 explore preset）
 *   - 用户说"能开始 X 吗"（直接开工）
 */
export function doesTaskNeedPlanning(msg: string): PlanDecision {
  const features = extractFeatures(msg);

  // ── auto_plan ──
  if (features.hasExplicitPlanIntent) return 'auto_plan';
  if (features.keywordHits >= 3) return 'auto_plan';
  if (features.fileRefCount >= 5 && features.keywordHits >= 1) return 'auto_plan';

  // ── suggest_plan ──
  if (
    features.fileRefCount >= 3 &&
    features.tokenCount >= 100 &&
    (features.keywordHits >= 1 || features.hasArchitectureQuery)
  ) {
    return 'suggest_plan';
  }
  if (features.hasArchitectureQuery && features.tokenCount >= 150) {
    return 'suggest_plan';
  }

  // ── no_plan ──
  return 'no_plan';
}
