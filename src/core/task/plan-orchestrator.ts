/**
 * Copyright (c) 2026 DualMind Contributors
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
export type PlanPhase = 'explore' | 'plan' | 'verify' | 'complete';

/** Orchestrator 状态 */
export interface OrchestratorState {
  phase: PlanPhase;
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
}

/** 创建初始状态 */
export function createOrchestratorState(): OrchestratorState {
  return {
    phase: 'explore',
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
  return {
    ...state,
    phase: 'explore',
    fallbackCount: state.fallbackCount + 1,
  };
}

/** 推进到下一阶段 */
export function advancePhase(state: OrchestratorState): OrchestratorState {
  const next: Record<PlanPhase, PlanPhase> = {
    explore: 'plan',
    plan: 'verify',
    verify: 'complete',
    complete: 'complete',
  };
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
