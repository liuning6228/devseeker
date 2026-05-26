/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 统一退避 + 可取消 sleep（DESIGN §M10.6 自愈重试链 · Provider 侧）
 *
 * 职责：
 * - `computeBackoff(code, attempt, retryAfterMs?)` 查 `RETRY_TABLE`，按策略算出本次等待毫秒数
 *   - linear：`baseMs * (attempt+1)`
 *   - exp：`baseMs * 2^attempt`
 *   - jitter：`baseMs * 2^attempt ± 20% random`
 *   - `maxMs` 封顶
 *   - `retryAfterMs` 优先：若服务端给了 Retry-After → 取 `max(retryAfterMs, computed)`（不低于服务端指令）
 *   - 所有结果最终 clamp 到 `[baseMs, maxMs ?? DEFAULT_MAX_MS]`
 *
 * - `sleepWithAbort(ms, signal)` 可取消睡眠；signal 已触发或中途触发立即 reject `AgentError(TASK_LOOP_ABORTED)`
 *
 * - `shouldRetry(code, attempt)` 纯查表：attempt 从 0 计，返回 `attempt < policy.attempts`
 *
 * 用法（Provider 侧）：
 * ```
 * let attempt = 0;
 * while (true) {
 *   try { yield* streamOnce(...); return; }
 *   catch (e) {
 *     const err = toAgentError(e);
 *     if (!shouldRetry(err.code, attempt)) throw err;
 *     const retryAfter = err.context?.retryAfterMs;
 *     await sleepWithAbort(computeBackoff(err.code, attempt, retryAfter), signal);
 *     attempt += 1;
 *   }
 * }
 * ```
 */

import { AgentError, ErrorCodes, RETRY_TABLE, type ErrorCode } from '../errors/index.js';

/** 未配置 maxMs 时的全局上限，避免单次等待过长（60s） */
const DEFAULT_MAX_MS = 60_000;

/** jitter 抖动幅度（±30%），对齐 Continue 的 0.4，防雷暴效应 */
const JITTER_RATIO = 0.3;

export interface ComputeBackoffOptions {
  /** 可注入的随机源（测试用） */
  random?: () => number;
}

/**
 * 返回某错误码在第 `attempt` 次失败后应等待的毫秒数。
 * 未在 RETRY_TABLE 中的错误码返回 0（不应 retry，调用方应先用 `shouldRetry` 过滤）。
 */
export function computeBackoff(
  code: ErrorCode | string,
  attempt: number,
  retryAfterMs?: number,
  opts: ComputeBackoffOptions = {},
): number {
  const policy = RETRY_TABLE[code as ErrorCode];
  if (!policy) return 0;

  const rand = opts.random ?? Math.random;
  const a = Math.max(0, attempt);
  const base = policy.baseMs;
  const max = policy.maxMs ?? DEFAULT_MAX_MS;

  let value: number;
  switch (policy.backoff) {
    case 'linear':
      value = base * (a + 1);
      break;
    case 'exp':
      value = base * Math.pow(2, a);
      break;
    case 'jitter': {
      const core = base * Math.pow(2, a);
      const delta = core * JITTER_RATIO;
      value = core + (rand() * 2 - 1) * delta;
      break;
    }
  }

  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    // 服务端指令优先：不低于 Retry-After
    value = Math.max(value, retryAfterMs);
  }

  // clamp
  if (value < base) value = base;
  if (value > max) value = max;
  return Math.round(value);
}

/** 纯查表：判断某错误码在第 `attempt` 次失败后是否还应该继续重试。 */
export function shouldRetry(code: ErrorCode | string, attempt: number): boolean {
  const policy = RETRY_TABLE[code as ErrorCode];
  if (!policy) return false;
  return attempt < policy.attempts;
}

/**
 * 解析 HTTP Retry-After header 返回毫秒数。
 * 支持两种格式：
 * - 秒数：`Retry-After: 5` → 5000
 * - HTTP-date：`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` → delta to now
 * 解析失败返回 undefined。
 */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.round(asNumber * 1000);
  }

  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) {
    const delta = ts - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/**
 * 可中断 sleep。
 * - signal 已 abort → 立即 reject（不等 tick）
 * - 睡眠过程中 abort → reject
 * - 正常到时 → resolve
 * 所有 reject 都是 `AgentError(TASK_LOOP_ABORTED)`，保证上层识别一致。
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(abortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): AgentError {
  return new AgentError({
    code: ErrorCodes.TASK_LOOP_ABORTED,
    message: 'Retry sleep aborted',
  });
}
