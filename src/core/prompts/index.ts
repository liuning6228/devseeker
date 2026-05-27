/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Prompts 模块统一出口（DESIGN §M3.2 / §M3.6）
 *
 * 外部只通过此 barrel 访问 Prompt 相关符号，避免到处直接 import layers/*。
 */

export { WEB_RESEARCH_PROMPT_MODULE } from './web-research.js';
export {
  DEFAULT_SYSTEM_PROMPT,
  buildL0Identity,
} from './layers/identity.js';
export { buildL1ToolsMode, type L1ToolsModeInput } from './layers/tools-mode.js';
export { buildL2RulesMemory, type L2RulesMemoryInput } from './layers/rules-memory.js';
export { buildL3Attachments, type L3AttachmentsInput } from './layers/attachments.js';
export {
  PromptBuilder,
  PROMPT_BUILDER_VERSION,
  dumpPromptSnapshot,
  type PromptBuildContext,
  type LayeredPrompt,
  type PromptSnapshot,
} from './builder.js';
export {
  computeCacheKey,
  computeLayerCacheKeys,
  type LayerCacheKeys,
} from './cache-boundary.js';
export {
  collectEnvironment,
  formatEnvironment,
  buildEnvironmentBlock,
  type EnvironmentSnapshot,
  type CollectOptions as EnvironmentCollectOptions,
} from './environment-probe.js';
export {
  detectEcosystems,
  formatEcosystemBlock,
  selectEcosystemModule,
  buildEcosystemBlock,
  HARMONYOS_SIGNALS,
  PACKAGE_JSON_SIGNALS,
  type EcosystemKind,
  type EcosystemDetection,
  type EcosystemProbeOptions,
  type FsLike as EcosystemFsLike,
} from './ecosystem-probe.js';
export { buildVlmOcrBlock, VLM_OCR_POLICY_MODULE } from './vlm-policy.js';
export {
  collectFrameworkContext,
  formatFrameworkContext,
  buildFrameworkContext,
  MAX_OPEN_TABS,
  MAX_WORKSPACE_TREE_LINES,
  WORKSPACE_TREE_EXCLUDES,
  type FrameworkContextSnapshot,
  type FrameworkContextCollectOptions,
  type OpenTabInfo,
} from './framework-context.js';
export {
  collectGitContext,
  formatGitContext,
  buildGitContextBlock,
  defaultGitCtxRunner,
  type GitContextSnapshot,
  type CollectGitContextOptions,
  type GitCtxRunner,
  type GitCtxRunResult,
} from './git-context.js';
export {
  estimateTokens,
  estimateContextTokens,
  applyTokenBudget,
  type TokenBudget,
  type TruncationReport,
} from './token-budget.js';
export {
  AGENT_IDENTITY_MODULE,
  TOOL_CONTRACTS_MODULE,
  GENERAL_BEHAVIOR_MODULE,
  MEMORY_POLICY_MODULE,
} from './modules/index.js';
export {
  ReminderInjector,
  BUILTIN_REMINDER_RULES,
  RULE_LANGUAGE_CONSISTENCY,
  RULE_STALE_TODO,
  RULE_LARGE_FILE,
  RULE_SKILL_ALREADY_LOADED,
  RULE_PLAN_MODE_WRITE_BLOCK,
  RULE_IDENTITY_PROTECTION,
  DEFAULT_MAX_REMINDERS_PER_TURN,
  DEFAULT_STALE_TODO_MS,
  DEFAULT_LARGE_FILE_LINES,
  DEFAULT_STALE_TODO_MIN_PENDING,
  type ReminderContext,
  type IReminderRule,
  type ReminderInjectorOptions,
} from './reminder-injector.js';
export {
  ContextAssembler,
  renderAttachments,
  attachmentsTokenCost,
  type IAttachment,
  type IContextAssembler,
  type AttachmentType,
  type BaseAttachment,
  type FileAttachment,
  type ImageAttachment,
  type SelectionAttachment,
  type GitCommitsAttachment,
  type CodeChangeAttachment,
} from './context-assembler.js';
