/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * RateLimiter（令牌桶）测试（W8.10 / DESIGN §M12.6）
 */

import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/core/web/rate-limiter.js';

describe('RateLimiter', () => {
  it('starts full at capacity', () => {
    const rl = new RateLimiter({ rps: 5 });
    expect(rl.available()).toBeCloseTo(5, 2);
  });

  it('tryAcquire succeeds until bucket empty', () => {
    let now = 1000;
    const rl = new RateLimiter({ rps: 3, now: () => now });
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(false);
  });

  it('refills over time', () => {
    let now = 1000;
    const rl = new RateLimiter({ rps: 2, now: () => now });
    rl.tryAcquire();
    rl.tryAcquire();
    expect(rl.tryAcquire()).toBe(false); // empty
    now = 1500; // 0.5s → 1 token
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(false);
  });

  it('caps at capacity (no overflow)', () => {
    let now = 1000;
    const rl = new RateLimiter({ rps: 2, capacity: 2, now: () => now });
    now = 10_000; // elapsed 9s → would give 18 tokens, but cap=2
    expect(rl.available()).toBeCloseTo(2, 2);
  });

  it('acquire() awaits until token is ready', async () => {
    let now = 1000;
    const sleepCalls: number[] = [];
    const rl = new RateLimiter({
      rps: 10, // 1 token per 100ms
      now: () => now,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        now += ms; // simulate clock advance
      },
    });
    // drain all 10 tokens
    for (let i = 0; i < 10; i++) rl.tryAcquire();
    expect(rl.tryAcquire()).toBe(false);

    await rl.acquire();
    // should have slept ~100ms once
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
    expect(sleepCalls[0]).toBeGreaterThanOrEqual(1);
  });

  it('acquire() respects AbortSignal', async () => {
    let now = 1000;
    const rl = new RateLimiter({
      rps: 1,
      now: () => now,
      sleep: async () => {
        /* do not advance now → forever waiting */
      },
    });
    rl.tryAcquire(); // empty
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(rl.acquire(ctrl.signal)).rejects.toThrow();
  });

  it('throws on rps <= 0', () => {
    expect(() => new RateLimiter({ rps: 0 })).toThrow();
  });
});
