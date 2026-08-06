/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Task 层 barrel export
 */
export { MessageHistory } from './history.js';
export { TaskLoop, type TaskLoopConfig } from './loop.js';
export type { TaskEvent } from './events.js';
export { evaluateTaskComplexity, extractComplexitySignals } from './task-complexity.js';
export type { ComplexityLevel, ComplexityResult, ComplexitySignals } from './task-complexity.js';
export { SpecManager, parseSpecDocument, parseFrontmatter, buildSpecContent, validateStatusTransition, sanitizeFeatureName } from './spec-manager.js';
export type { SpecStatus, SpecMeta, SpecDocument, SpecSummary } from './spec-manager.js';
export { createOrchestratorState, advancePhase, shouldFallback, applyFallback, buildExplorePrompt, buildVerifyPrompt, buildRequirementPrompt, buildTaskSplitPrompt } from './plan-orchestrator.js';
export type { PlanPhase, OrchestrationMode, OrchestratorState } from './plan-orchestrator.js';
