/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Task Complexity Evaluator —— 任务复杂度评估器（P1）
 *
 * 将用户输入分类为三个复杂度级别：
 * - vibe：简单修改，直接执行（bug fix、配置修改、单文件改动）
 * - plan：中等任务，需要规划（多文件改动、需求明确的重构）
 * - spec：Feature 级复杂任务，需要 Spec 工作流（跨模块、需求模糊、大型功能）
 *
 * 设计来源：
 * - spec-workflow-and-knowledge-engine.md §五 · 智能模式选择
 * - decision-tree.ts 的扩展，从二元（plan/no_plan）升级为三级
 *
 * 纯函数，无副作用。输入 user message → 输出复杂度分类 + 信号明细。
 */

// ─────────── Types ───────────

/** 复杂度级别 */
export type ComplexityLevel = 'vibe' | 'plan' | 'spec';

/** 评估结果 */
export interface ComplexityResult {
  /** 复杂度级别 */
  level: ComplexityLevel;
  /** 置信度 0-1（越高越确定） */
  confidence: number;
  /** 命中的信号明细（调试用） */
  signals: ComplexitySignals;
}

/** 信号明细 */
export interface ComplexitySignals {
  /** Feature 级关键词命中 */
  featureScopeHits: number;
  /** 跨模块/跨系统信号 */
  crossModuleHits: number;
  /** 需求模糊信号 */
  vagueRequirementHits: number;
  /** 显式 Spec 意图（"走 Spec 流程"等） */
  explicitSpecIntent: boolean;
  /** 显式 Plan 意图（"帮我设计/规划"等） */
  explicitPlanIntent: boolean;
  /** 架构关键词命中数 */
  architectureHits: number;
  /** 文件引用数量 */
  fileRefCount: number;
  /** 消息 token 估算 */
  tokenCount: number;
  /** 简单任务信号（bug fix、typo 等） */
  simpleTaskHits: number;
}

// ─────────── Keywords ───────────

/**
 * Feature 级关键词 —— 暗示大型功能开发。
 * 这些词通常出现在"实现一个新功能/新系统"的上下文中。
 */
const FEATURE_SCOPE_KEYWORDS = [
  '新功能', '新模块', '新系统', '新特性',
  '实现.*功能', '开发.*模块', '搭建.*系统',
  'new feature', 'new module', 'new system',
  'implement.*feature', 'build.*module', 'create.*system',
  '从零开始', 'from scratch',
  '完整实现', 'full implementation',
  '端到端', 'end-to-end', 'e2e',
  // 更宽泛的模式：新.*模块/功能/系统，全新.*
  '新.*模块', '新.*功能', '新.*系统',
  '全新', '实现.*支付', '实现.*认证', '实现.*登录',
];

/**
 * 跨模块/跨系统关键词 —— 暗示影响面广。
 */
const CROSS_MODULE_KEYWORDS = [
  '跨模块', '跨服务', '跨系统', '跨组件',
  '多个模块', '多个服务', '多个系统',
  'cross-module', 'cross-service', 'cross-system',
  'multiple modules', 'multiple services',
  '全局', 'global', 'system-wide',
  '整个项目', '整个系统', '全链路',
  '前后端', 'full-stack', 'fullstack',
];

/**
 * 需求模糊信号 —— 用户自己也不清楚要什么。
 * 这类输入通常需要 Spec 的 Requirement 阶段来澄清。
 */
const VAGUE_REQUIREMENT_PATTERNS = [
  '能不能', '是否可以', '有没有办法',
  'can we', 'is it possible', 'how can we',
  '我想.*一下', '考虑.*一下', '探讨',
  '优化.*体验', '提升.*质量', '改善',
  '更好的.*方案', '有没有更好',
  '不确定', '不太清楚', '还没想好',
  '大概', '也许', '可能',
];

/**
 * 显式 Spec 意图 —— 用户明确要求走 Spec 流程。
 */
const EXPLICIT_SPEC_INTENT = [
  '走 spec 流程', '走spec流程', 'spec 工作流',
  '写个 spec', '写spec', '创建 spec',
  'spec workflow', 'write a spec', 'create a spec',
  '需求梳理', '需求分析', 'requirement analysis',
  '先梳理需求', '先明确需求',
];

/**
 * 显式 Plan 意图 —— 用户要求规划但不需要 Spec 级别。
 */
const EXPLICIT_PLAN_INTENT = [
  '帮我设计', '帮我规划',
  '设计方案', '规划方案',
  'design', 'plan for',
  'architecture for',
  'how should I',
  'what approach',
  'compare options',
];

/**
 * 架构关键词 —— 中等权重。
 */
const ARCHITECTURE_KEYWORDS = [
  'refactor', '重构',
  '架构', 'architect', 'architecture',
  '迁移', 'migration', 'migrate',
  'redesign', '重塑',
  'observability', '可观测',
  '设计', 'design',
  '规划', 'plan',
];

/**
 * 简单任务信号 —— 降低复杂度评估。
 */
const SIMPLE_TASK_PATTERNS = [
  '修复.*bug', 'fix.*bug', 'fix.*typo',
  '修改.*拼写', 'typo',
  '改一下.*配置', 'change.*config', 'update.*config',
  '添加.*注释', 'add.*comment',
  '删除.*注释', 'remove.*comment',
  '重命名', 'rename',
  '更新.*readme', 'update.*readme',
  '格式化', 'format',
  'lint', 'eslint',
];

// ─────────── Core Functions ───────────

/**
 * 从 user message 提取复杂度信号。
 */
export function extractComplexitySignals(msg: string): ComplexitySignals {
  const lower = msg.toLowerCase();

  // Feature 级关键词
  const featureScopeHits = countPatternHits(lower, FEATURE_SCOPE_KEYWORDS);

  // 跨模块信号
  const crossModuleHits = countPatternHits(lower, CROSS_MODULE_KEYWORDS);

  // 需求模糊信号
  const vagueRequirementHits = countPatternHits(lower, VAGUE_REQUIREMENT_PATTERNS);

  // 显式 Spec 意图
  const explicitSpecIntent = EXPLICIT_SPEC_INTENT.some((kw) => lower.includes(kw));

  // 显式 Plan 意图
  const explicitPlanIntent = EXPLICIT_PLAN_INTENT.some((kw) => lower.includes(kw));

  // 架构关键词
  const architectureHits = ARCHITECTURE_KEYWORDS.reduce((count, kw) => {
    return count + (lower.includes(kw) ? 1 : 0);
  }, 0);

  // 文件引用数量
  const fileRefs = msg.match(
    /[\w\-./]+\.(ts|js|tsx|jsx|py|go|rs|java|kt|swift|css|scss|vue|svelte|html):?\d*/g,
  );
  const fileRefCount = fileRefs ? fileRefs.length : 0;

  // Token 估算
  const cjkCount = (msg.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const asciiCount = msg.length - cjkCount;
  const tokenCount = Math.ceil(asciiCount / 4) + Math.ceil(cjkCount / 2);

  // 简单任务信号
  const simpleTaskHits = countPatternHits(lower, SIMPLE_TASK_PATTERNS);

  return {
    featureScopeHits,
    crossModuleHits,
    vagueRequirementHits,
    explicitSpecIntent,
    explicitPlanIntent,
    architectureHits,
    fileRefCount,
    tokenCount,
    simpleTaskHits,
  };
}

/**
 * 任务复杂度评估主入口。
 *
 * 决策逻辑（按优先级从高到低）：
 *
 * spec 级别：
 *   - 显式 Spec 意图
 *   - Feature 级关键词 ≥ 2
 *   - Feature 级 ≥ 1 + 跨模块 ≥ 1
 *   - Feature 级 ≥ 1 + 需求模糊 ≥ 2
 *   - 跨模块 ≥ 2 + 需求模糊 ≥ 1
 *   - 文件引用 ≥ 8 + 架构关键词 ≥ 2
 *
 * plan 级别：
 *   - 显式 Plan 意图
 *   - 架构关键词 ≥ 3
 *   - 文件引用 ≥ 5 + 架构关键词 ≥ 1
 *   - 文件引用 ≥ 3 + token ≥ 100 + (架构 ≥ 1 或 架构性提问)
 *   - 架构性提问 + token ≥ 150
 *
 * vibe 级别：
 *   - 简单任务信号命中
 *   - 其他所有情况（默认）
 */
export function evaluateTaskComplexity(msg: string): ComplexityResult {
  const signals = extractComplexitySignals(msg);

  // ── spec 级别（高优先级） ──
  if (signals.explicitSpecIntent) {
    return { level: 'spec', confidence: 0.95, signals };
  }
  if (signals.featureScopeHits >= 2) {
    return { level: 'spec', confidence: 0.85, signals };
  }
  if (signals.featureScopeHits >= 1 && signals.crossModuleHits >= 1) {
    return { level: 'spec', confidence: 0.80, signals };
  }
  if (signals.featureScopeHits >= 1 && signals.vagueRequirementHits >= 2) {
    return { level: 'spec', confidence: 0.75, signals };
  }
  if (signals.crossModuleHits >= 2 && signals.vagueRequirementHits >= 1) {
    return { level: 'spec', confidence: 0.75, signals };
  }
  if (signals.fileRefCount >= 8 && signals.architectureHits >= 2) {
    return { level: 'spec', confidence: 0.70, signals };
  }

  // ── plan 级别 ──
  if (signals.explicitPlanIntent) {
    return { level: 'plan', confidence: 0.90, signals };
  }
  if (signals.architectureHits >= 3) {
    return { level: 'plan', confidence: 0.80, signals };
  }
  if (signals.fileRefCount >= 5 && signals.architectureHits >= 1) {
    return { level: 'plan', confidence: 0.75, signals };
  }
  if (
    signals.fileRefCount >= 3 &&
    signals.tokenCount >= 100 &&
    (signals.architectureHits >= 1 || signals.vagueRequirementHits >= 1)
  ) {
    return { level: 'plan', confidence: 0.65, signals };
  }
  // 长消息 + 多文件引用（即使没有明确架构词，也可能是中等任务）
  if (signals.fileRefCount >= 5 && signals.tokenCount >= 150) {
    return { level: 'plan', confidence: 0.60, signals };
  }

  // ── vibe 级别（默认） ──
  const confidence = signals.simpleTaskHits > 0 ? 0.85 : 0.70;
  return { level: 'vibe', confidence, signals };
}

// ─────────── Helpers ───────────

/**
 * 统计 patterns 中有多少在 text 中被命中。
 * 支持简单字符串和正则模式（用 `.*` 连接的模式）。
 */
function countPatternHits(text: string, patterns: string[]): number {
  return patterns.reduce((count, pattern) => {
    try {
      const regex = new RegExp(pattern);
      return count + (regex.test(text) ? 1 : 0);
    } catch {
      // 非法正则，按简单字符串匹配
      return count + (text.includes(pattern) ? 1 : 0);
    }
  }, 0);
}
