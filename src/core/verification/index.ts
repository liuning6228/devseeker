/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CVW（Change Verification Workflow）模块入口
 *
 * 详见 docs/verification-workflow-optimization-plan.md
 *
 * 子系统：
 *   types                  · 状态机与数据契约（纯类型 + 纯判定）
 *   test-framework-detector· A 测试框架探测（确定性下沉）
 *   test-targeting         · B 变更影响分析（约定映射 + 图索引反向依赖）
 *   gate                   · C 梯度验证门（纯决策 + 注入文本）
 *   output-parser          · E 测试输出解析（无界 stdout → <1KB 摘要）
 *   file-relevance         · 变更文件分类（纯文档放行，§4.3 补充）
 */

export type {
  VerificationState,
  VerificationGateMode,
  TestFramework,
  TestConventions,
  TestPlan,
  TestFailureRef,
  TestRunSummary,
  GateAction,
  GateDecision,
  VerificationConfig,
  VerificationTier,
} from './types.js';
export {
  DEFAULT_VERIFICATION_CONFIG,
  MAX_SOFT_PROMPTS,
  decideTier,
  isVerificationState,
  isGateMode,
  normalizeVerificationConfig,
} from './types.js';

export { detectTestPlan, clearTestPlanCache } from './test-framework-detector.js';

export type { GraphIndexLike, TargetingResult } from './test-targeting.js';
export { computeAffectedTests, buildTestCommand, isTestPath } from './test-targeting.js';

export type { GateInput, GatePromptContext, UnverifiedReason } from './gate.js';
export {
  decideGate,
  buildGatePrompt,
  buildFixPrompt,
  buildUnverifiedWarning,
  isVerificationCommand,
} from './gate.js';

export { parseTestOutput, parseVerifyReport, renderTestSummary, stripAnsi } from './output-parser.js';

export { isDocumentationFile, isDocOnlyChange } from './file-relevance.js';
