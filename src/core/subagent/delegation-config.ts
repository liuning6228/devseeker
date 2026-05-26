/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 安全隔离配置（Phase 5 Phase B Step 7）
 *
 * L1 工具级：DELEGATE_BLOCKED_TOOLS 硬编码（已在 types.ts 中定义）
 * L2 调用级：auto-approve/deny + maxDepth(1-3) + maxChildren(3)
 * L3 运行级：V1 不做（⏳ 推迟）
 *
 * DESIGN-1.md §4.4 · ROADMAP.md 方案一 Phase B Step 7
 */

/** 安全隔离配置 */
export interface IsolationConfig {
  /** 最大嵌套深度（1=平坦，2=orchestrator→leaf 一级嵌套，上限 3） */
  maxDepth: number;
  /** 是否自动批准子代理的危险命令 */
  autoApprove: boolean;
  /** 子代理超时秒数（默认 600） */
  timeoutSeconds: number;
  /** 并行子代理上限（默认 3） */
  maxChildren: number;
}

/** 默认配置 */
export const DEFAULT_ISOLATION: IsolationConfig = {
  maxDepth: 2,
  autoApprove: false,
  timeoutSeconds: 600,
  maxChildren: 3,
};

/**
 * 校验并归一化隔离配置。
 * 超限值自动钳位到允许范围内。
 */
export function normalizeIsolation(raw: Partial<IsolationConfig>): IsolationConfig {
  return {
    maxDepth: clamp(raw.maxDepth ?? DEFAULT_ISOLATION.maxDepth, 1, 3),
    autoApprove: raw.autoApprove ?? DEFAULT_ISOLATION.autoApprove,
    timeoutSeconds: Math.max(30, raw.timeoutSeconds ?? DEFAULT_ISOLATION.timeoutSeconds),
    maxChildren: clamp(raw.maxChildren ?? DEFAULT_ISOLATION.maxChildren, 1, 10),
  };
}

/**
 * 根据当前深度判断子代理是否允许 spawn 子代理。
 * 若 depth >= maxDepth，子代理的 `delegate_task` 工具应从白名单移除。
 */
export function canSpawn(depth: number, maxDepth: number): boolean {
  return depth < maxDepth;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
