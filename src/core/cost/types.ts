/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Cost 模块类型契约（DESIGN §M16.3）
 *
 * MVP 说明：
 * - `IUsageRecord` 是单次 token 用量的原子单位，覆盖 chat / embed / search / fetch 四种操作。
 * - `ICostTracker` 对齐 DESIGN 契约（record / summary / todayCost）；estimate 留给 W8+。
 * - `CostSink` 是副作用注入点：每次 record 可选同步写入（例如 JSONL 落盘）。
 */

import type { ProviderId } from '../../providers/types.js';

export type UsageOperation = 'chat' | 'embed' | 'search' | 'fetch';

export interface IUsageRecord {
  /** Unix ms */
  ts: number;
  provider: ProviderId | string;
  model?: string;
  operation: UsageOperation;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** 成本数值（币种按 currency 字段，不做换算） */
  cost: number;
  currency: 'CNY' | 'USD';
  sessionId?: string;
  turnId?: string;
}

export interface UsageFilter {
  /** 含边界 */
  since?: number;
  /** 不含边界 */
  until?: number;
  provider?: string;
  operation?: UsageOperation;
  sessionId?: string;
}

export interface UsageSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costByCurrency: { CNY: number; USD: number };
}

/**
 * 持久化汇点 —— 每次 record 后调 write（fire-and-forget，失败不影响主流程）。
 */
export interface CostSink {
  append(record: IUsageRecord): Promise<void> | void;
}
