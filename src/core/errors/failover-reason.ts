/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * FailoverReason —— 错误分类路由
 *
 * 对齐 Qoder 9 种 FailoverReason 分类，用于精准路由降级策略：
 * - rate_limit / timeout / overloaded → 降级到下一 Level
 * - context_overflow → 同级压缩重试
 * - billing / auth → 不降级（跨级大概率也失败）
 * - stream_broken → 同级重推
 * - format → 不降级（消息格式错误，换模型也没用）
 *
 * 来源：6 项目 8 维度对比分析 + Qoder failover-error.ts 9 种分类
 */

export type FailoverReason =
  | 'rate_limit'       // 429 / too many requests (temporary)
  | 'daily_quota'      // 429 / daily quota exhausted (not retryable)
  | 'timeout'          // ECONNRESET / EPIPE / ETIMEDOUT 等 11 种 socket 错误
  | 'overloaded'       // 529 / server overloaded
  | 'billing'          // 402 / insufficient quota
  | 'auth'             // 401 / 403 / invalid/expired key
  | 'format'           // 400 / bad request (消息格式错误)
  | 'stream_broken'    // SSE 中间断连
  | 'context_overflow' // context length exceeded
  | 'model_not_found'; // 404 / model not found

/** FailoverReason → 降级策略映射 */
export type FallbackStrategy =
  | 'next_level'      // 降级到下一 Level
  | 'same_level_retry' // 同级重试（不降级）
  | 'no_fallback';     // 不降级（跨级大概率也失败）

/** FailoverReason → 降级策略 */
export const FAILOVER_STRATEGY: Record<FailoverReason, FallbackStrategy> = {
  rate_limit: 'next_level',
  daily_quota: 'next_level',    // 每日配额耗尽，不重试直接降级
  timeout: 'next_level',
  overloaded: 'next_level',
  billing: 'no_fallback',
  auth: 'no_fallback',
  format: 'no_fallback',
  stream_broken: 'same_level_retry',
  context_overflow: 'same_level_retry',
  model_not_found: 'next_level',
};

/** 从 ErrorCode 字符串推断 FailoverReason */
export function classifyErrorCode(code: string): FailoverReason {
  if (code.includes('DAILY_QUOTA_EXCEEDED')) return 'daily_quota';
  if (code.includes('RATE_LIMITED')) return 'rate_limit';
  if (code.includes('NET.TIMEOUT') || code.includes('NET.UNREACHABLE')) return 'timeout';
  if (code.includes('SERVER_OVERLOADED')) return 'overloaded';
  if (code.includes('SERVER_5XX')) return 'overloaded'; // 5xx 统一归为 overloaded
  if (code.includes('BILLING') || code.includes('INSUFFICIENT_QUOTA')) return 'billing';
  if (code.includes('AUTH') || code.includes('INVALID_API_KEY') || code.includes('EXPIRED') || code.includes('SESSION_EXPIRED')) return 'auth';
  if (code.includes('BAD_REQUEST')) return 'format';
  if (code.includes('STREAM_BROKEN')) return 'stream_broken';
  if (code.includes('CONTEXT_OVERFLOW')) return 'context_overflow';
  if (code.includes('MODEL_NOT_FOUND') || code.includes('NOT_FOUND')) return 'model_not_found';
  // 兜底：未知错误视为 timeout（可重试）
  return 'timeout';
}

/** 11 种 Socket 错误码（对齐 Qoder failover-error.ts） */
export const SOCKET_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETRESET',
  'EPIPE',
  'EAI_AGAIN',
]);

/** 检查错误是否为 socket 层错误 */
export function isSocketError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Record<string, unknown>;
  const code = (err as any).code ?? (err as any).cause?.code;
  return typeof code === 'string' && SOCKET_ERROR_CODES.has(code);
}

/** 从 socket 错误获取 FailoverReason（统一归为 timeout） */
export function classifySocketError(_error: unknown): FailoverReason {
  return 'timeout';
}
