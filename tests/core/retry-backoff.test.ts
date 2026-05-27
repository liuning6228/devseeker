/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * tests/core/retry-backoff.test.ts
 *
 * 覆盖 W7b5b Provider 侧自愈重试模块：
 * - computeBackoff 各分支（linear / exp / jitter / retryAfter 优先 / clamp / unknown code / maxMs 封顶）
 * - shouldRetry 纯查表
 * - parseRetryAfter 秒数 / HTTP-date / 非法值
 * - sleepWithAbort 正常 resolve / pre-aborted / 中途 abort / ms<=0 立即 resolve
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  computeBackoff,
  shouldRetry,
  parseRetryAfter,
  sleepWithAbort,
} from '../../src/core/retry/backoff.js';
import { AgentError, ErrorCodes } from '../../src/core/errors/index.js';

describe('computeBackoff', () => {
  it('未在 RETRY_TABLE 中的错误码 → 0', () => {
    expect(computeBackoff(ErrorCodes.INTERNAL_ASSERTION_FAILED, 0)).toBe(0);
    expect(computeBackoff('NOT_EXISTING_CODE', 3)).toBe(0);
  });

  it('jitter: PROVIDER_STREAM_BROKEN baseMs=1500 → 1500/3000/6000（注入 random=0.5 去抖动）', () => {
    const zeroRand = (): number => 0.5;
    expect(computeBackoff(ErrorCodes.PROVIDER_STREAM_BROKEN, 0, undefined, { random: zeroRand })).toBe(1500);
    expect(computeBackoff(ErrorCodes.PROVIDER_STREAM_BROKEN, 1, undefined, { random: zeroRand })).toBe(3000);
    expect(computeBackoff(ErrorCodes.PROVIDER_STREAM_BROKEN, 2, undefined, { random: zeroRand })).toBe(6000);
  });

  it('jitter: PROVIDER_SERVER_5XX baseMs=1000 → 1000/2000/4000（注入 random=0.5 去抖动）', () => {
    const zeroRand = (): number => 0.5;
    expect(computeBackoff(ErrorCodes.PROVIDER_SERVER_5XX, 0, undefined, { random: zeroRand })).toBe(1000);
    expect(computeBackoff(ErrorCodes.PROVIDER_SERVER_5XX, 1, undefined, { random: zeroRand })).toBe(2000);
    expect(computeBackoff(ErrorCodes.PROVIDER_SERVER_5XX, 2, undefined, { random: zeroRand })).toBe(4000);
  });

  it('jitter: PROVIDER_RATE_LIMITED maxMs=30000 封顶', () => {
    const zeroRand = (): number => 0.5;
    // baseMs=2000, attempt=5 → 2000*32=64000 → clamp 到 30000
    expect(computeBackoff(ErrorCodes.PROVIDER_RATE_LIMITED, 5, undefined, { random: zeroRand })).toBe(30000);
  });

  it('retryAfterMs 优先：computed 比它小时取 retryAfterMs', () => {
    const zeroRand = (): number => 0.5;
    const wait = computeBackoff(ErrorCodes.PROVIDER_RATE_LIMITED, 0, 8000, { random: zeroRand });
    expect(wait).toBe(8000);
  });

  it('retryAfterMs 小于 computed → 用 computed', () => {
    const zeroRand = (): number => 0.5;
    const wait = computeBackoff(ErrorCodes.PROVIDER_RATE_LIMITED, 2, 500, { random: zeroRand });
    expect(wait).toBe(8000);
  });

  it('retryAfterMs 超过 maxMs 时也会被 clamp', () => {
    const zeroRand = (): number => 0.5;
    const wait = computeBackoff(ErrorCodes.PROVIDER_RATE_LIMITED, 0, 60000, { random: zeroRand });
    expect(wait).toBe(30000);
  });

  it('jitter with random=0.5 → core 值', () => {
    const r = (): number => 0.5;
    const a = computeBackoff(ErrorCodes.PROVIDER_STREAM_BROKEN, 0, undefined, { random: r });
    expect(a).toBe(1500);
  });

  it('负 attempt 按 0 处理', () => {
    const zeroRand = (): number => 0.5;
    expect(computeBackoff(ErrorCodes.PROVIDER_SERVER_5XX, -5, undefined, { random: zeroRand })).toBe(1000);
  });
});

describe('shouldRetry', () => {
  it('未配置错误码 → false', () => {
    expect(shouldRetry(ErrorCodes.INTERNAL_ASSERTION_FAILED, 0)).toBe(false);
  });

  it('attempt < attempts → true', () => {
    // PROVIDER_STREAM_BROKEN attempts=5（查表确认）
    expect(shouldRetry(ErrorCodes.PROVIDER_STREAM_BROKEN, 0)).toBe(true);
    expect(shouldRetry(ErrorCodes.PROVIDER_STREAM_BROKEN, 3)).toBe(true);
    expect(shouldRetry(ErrorCodes.PROVIDER_STREAM_BROKEN, 4)).toBe(true);
  });

  it('attempt >= attempts → false', () => {
    // PROVIDER_STREAM_BROKEN attempts=5
    expect(shouldRetry(ErrorCodes.PROVIDER_STREAM_BROKEN, 5)).toBe(false);
    expect(shouldRetry(ErrorCodes.PROVIDER_STREAM_BROKEN, 99)).toBe(false);
  });

  it('PROVIDER_SERVER_5XX attempts=3', () => {
    expect(shouldRetry(ErrorCodes.PROVIDER_SERVER_5XX, 0)).toBe(true);
    expect(shouldRetry(ErrorCodes.PROVIDER_SERVER_5XX, 2)).toBe(true);
    expect(shouldRetry(ErrorCodes.PROVIDER_SERVER_5XX, 3)).toBe(false);
  });

  it('PROVIDER_RATE_LIMITED attempts=5', () => {
    expect(shouldRetry(ErrorCodes.PROVIDER_RATE_LIMITED, 4)).toBe(true);
    expect(shouldRetry(ErrorCodes.PROVIDER_RATE_LIMITED, 5)).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('null / undefined / 空串 → undefined', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('   ')).toBeUndefined();
  });

  it('秒数字符串 → 毫秒', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(' 12 ')).toBe(12000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('0.5')).toBe(500);
  });

  it('HTTP-date → 当前时间差（正值）', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const v = parseRetryAfter(future);
    expect(v).toBeDefined();
    expect(v!).toBeGreaterThan(5_000);
    expect(v!).toBeLessThanOrEqual(10_000);
  });

  it('过去的 HTTP-date → 0', () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });

  it('非法字符串 → undefined', () => {
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
    expect(parseRetryAfter('abc123')).toBeUndefined();
  });
});

describe('sleepWithAbort', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ms <= 0 → 立即 resolve', async () => {
    await expect(sleepWithAbort(0)).resolves.toBeUndefined();
    await expect(sleepWithAbort(-100)).resolves.toBeUndefined();
  });

  it('正常到期 → resolve', async () => {
    const p = sleepWithAbort(20);
    await expect(p).resolves.toBeUndefined();
  });

  it('pre-aborted signal → 立即 reject AgentError(TASK_LOOP_ABORTED)', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleepWithAbort(1000, ac.signal)).rejects.toBeInstanceOf(AgentError);
    try {
      await sleepWithAbort(1000, ac.signal);
    } catch (e) {
      expect((e as AgentError).code).toBe(ErrorCodes.TASK_LOOP_ABORTED);
    }
  });

  it('sleep 期间 abort → reject AgentError(TASK_LOOP_ABORTED)', async () => {
    const ac = new AbortController();
    const p = sleepWithAbort(10_000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toBeInstanceOf(AgentError);
  });

  it('无 signal → 正常 resolve', async () => {
    await expect(sleepWithAbort(10, undefined)).resolves.toBeUndefined();
  });

  it('resolve 后再 abort 不会 double-settle', async () => {
    const ac = new AbortController();
    await sleepWithAbort(5, ac.signal);
    ac.abort();
    // 若重复 settle 会抛未处理异常，这里仅验证不抛
    await new Promise((r) => setTimeout(r, 5));
    expect(true).toBe(true);
  });
});
