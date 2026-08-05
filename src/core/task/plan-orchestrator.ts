/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Plan orchestrator 三阶段流程（Phase 5 Phase B Step 7）
 *
 * 利用 delegate_task 实现 Plan 三阶段：
 * Phase 1：探索（delegate_task preset='explorer', role='leaf', mode='fork'）
 * Phase 2：规划（LLM 自身决策，调用 create_plan）
 * Phase 3：校验（delegate_task preset='verifier', role='leaf', mode='fork'）
 *
 * 失败回退：信息不足时退回 Phase 1（最多 1 次）。
 *
 * DESIGN-1.md §4.1 · ROADMAP.md 方案二 Phase B Step 7
 */

import type { ToolContext } from '../tools/types.js';

/** Plan orchestration 阶段 */
export type PlanPhase = 'requirement' | 'explore' | 'plan' | 'task_split' | 'verify' | 'complete';

/** Orchestrator 模式：Plan（第二代）或 Spec（第三代） */
export type OrchestrationMode = 'plan' | 'spec';

/** Orchestrator 状态 */
export interface OrchestratorState {
  phase: PlanPhase;
  /** 编排模式：plan（默认）或 spec */
  mode: OrchestrationMode;
  /** 回退计数 */
  fallbackCount: number;
  /** 最大回退次数 */
  maxFallback: number;
  /** 探索阶段产出的文件清单 + 关键接口 */
  exploreArtifacts?: {
    files: string[];
    interfaces: string[];
    risks: string[];
  };
  /** Spec 模式下的 feature 名称 */
  specFeature?: string;
}

/** 创建初始状态 */
export function createOrchestratorState(mode: OrchestrationMode = 'plan'): OrchestratorState {
  return {
    phase: mode === 'spec' ? 'requirement' : 'explore',
    mode,
    fallbackCount: 0,
    maxFallback: 1,
  };
}

/** 判断是否触发回退 */
export function shouldFallback(state: OrchestratorState): boolean {
  return state.fallbackCount < state.maxFallback;
}

/** 执行回退 */
export function applyFallback(state: OrchestratorState): OrchestratorState {
  // Spec 模式回退到 explore，Plan 模式也回退到 explore
  return {
    ...state,
    phase: 'explore',
    fallbackCount: state.fallbackCount + 1,
  };
}

/** 推进到下一阶段 */
export function advancePhase(state: OrchestratorState): OrchestratorState {
  // Spec 模式：requirement → explore → plan → task_split → verify → complete
  // Plan 模式：explore → plan → verify → complete
  const planNext: Record<PlanPhase, PlanPhase> = {
    requirement: 'explore',
    explore: 'plan',
    plan: 'verify',
    task_split: 'verify',
    verify: 'complete',
    complete: 'complete',
  };
  const specNext: Record<PlanPhase, PlanPhase> = {
    requirement: 'explore',
    explore: 'plan',
    plan: 'task_split',
    task_split: 'verify',
    verify: 'complete',
    complete: 'complete',
  };
  const next = state.mode === 'spec' ? specNext : planNext;
  return { ...state, phase: next[state.phase] };
}

/**
 * 构建探索阶段的 delegate_task prompt。
 * 包含探索目标 + 产出要求。
 */
export function buildExplorePrompt(goal: string): string {
  return [
    `探索任务：${goal}`,
    '',
    '请按以下要求探索代码库并产出报告：',
    '1. 使用 `search_codebase` 定位受影响的文件和模块。',
    '2. 使用 `lsp.goToDefinition` / `lsp.findReferences` 追踪关键符号的调用链。',
    '3. 使用 `read_file` 查看关键函数的实现。',
    '4. 使用 `list_dir` 了解目录结构。',
    '',
    '产出格式：',
    '```',
    '## 受影响文件',
    '- path/to/file1.ts — 原因: XXX',
    '- path/to/file2.ts — 原因: YYY',
    '',
    '## 关键接口',
    '- InterfaceX — 定义在 path/to/file.ts:L10-L25',
    '- FunctionY — 调用链: A → B → C',
    '',
    '## 风险区域',
    '- 风险描述 — 影响: ZZZ',
    '```',
    '',
    '注意：不要修改任何文件，你只有只读权限。',
  ].join('\n');
}

/**
 * 构建校验阶段的 delegate_task prompt。
 * 校验 plan 中文件/符号的存在性。
 */
export function buildVerifyPrompt(planId: string, files: string[]): string {
  const fileList = files.map((f) => `  - ${f}`).join('\n');
  return [
    `校验 Plan：${planId}`,
    '',
    '请验证以下文件/符号在代码库中是否存在：',
    '',
    fileList,
    '',
    '对每个条目，返回：',
    '- ✅ 文件存在 / 符号可解析',
    '- ❌ 文件不存在 / 符号未找到 —— 指明具体路径和建议',
    '',
    '使用 `search_codebase`、`read_file`、`lsp` 工具验证。',
    '不要修改任何文件。',
  ].join('\n');
}

/**
 * 构建需求梳理阶段的 prompt（Spec 模式专用）。
 * 引导 Agent 通过 AskUserQuestion 收集需求细节。
 */
export function buildRequirementPrompt(goal: string): string {
  return [
    `需求梳理任务：${goal}`,
    '',
    '请按以下步骤收集需求细节：',
    '',
    '1. **理解目标**：用户想实现什么？核心价值是什么？',
    '2. **明确边界**：哪些在范围内，哪些不在？',
    '3. **探索约束**：技术约束、性能要求、兼容性等。',
    '4. **发现边界情况**：错误处理、空状态、权限等。',
    '',
    '使用 `AskUserQuestion` 工具向用户提问（每次最多 4 个问题）。',
    '收集足够信息后，输出结构化的需求文档：',
    '',
    '```markdown',
    '## 需求（Requirement）',
    '',
    '### 用户故事',
    '- 作为 [角色]，我希望 [功能]，以便 [价值]',
    '',
    '### 验收条件',
    '1. 当 [条件] 时，系统应当 [行为]',
    '2. ...',
    '',
    '### 边界情况',
    '- [错误处理、空状态、权限等]',
    '```',
  ].join('\n');
}

/**
 * 构建任务拆分阶段的 prompt（Spec 模式专用）。
 * 基于需求和方案，拆解出离散的实现任务。
 */
export function buildTaskSplitPrompt(
  feature: string,
  requirementSummary: string,
  designSummary: string,
): string {
  return [
    `任务拆分：${feature}`,
    '',
    '基于以下需求和方案，拆解出离散的实现任务列表。',
    '',
    '## 需求摘要',
    requirementSummary,
    '',
    '## 方案摘要',
    designSummary,
    '',
    '## 拆分规则',
    '- 每个任务足够小，可以在 1 个 Agent turn 内完成',
    '- 每个任务必须关联至少一个验收条件',
    '- 任务之间有依赖时，按依赖顺序排列',
    '- 最多拆分 15 个任务',
    '',
    '## 输出格式',
    '```markdown',
    '## 任务（Tasks）',
    '- [ ] 1. 具体任务描述',
    '  - _验收条件: #1, #2_',
    '  - _受影响文件: src/xxx/yyy.ts_',
    '- [ ] 2. ...',
    '```',
  ].join('\n');
}
