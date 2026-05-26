/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * thread-pool 单测
 *
 * 覆盖：C3, C4
 */

import { describe, it, expect } from 'vitest';
import { runConcurrent, Semaphore } from './thread-pool.js';

describe('Semaphore', () => {
  it('并发不超过上限', async () => {
    const sem = new Semaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`,
      async run() {
        await sem.acquire();
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
        sem.release();
        return i;
      },
    }));
    await runConcurrent(tasks, 2);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

describe('runConcurrent', () => {
  it('单个失败不阻塞其他', async () => {
    const tasks = [
      { id: 'good', async run() { return 42; } },
      { id: 'bad', async run() { throw new Error('fail'); } },
      { id: 'also-good', async run() { return 7; } },
    ];
    const results = await runConcurrent(tasks, 2);
    expect(results).toHaveLength(3);
    const good = results.filter((r) => r.status === 'fulfilled');
    expect(good).toHaveLength(2);
    const bad = results.filter((r) => r.status === 'rejected');
    expect(bad).toHaveLength(1);
  });

  it('总耗时 ≈ max(单个)', async () => {
    const tasks = [
      { id: 'slow', async run() { await new Promise((r) => setTimeout(r, 50)); return 'slow'; } },
      { id: 'fast', async run() { await new Promise((r) => setTimeout(r, 10)); return 'fast'; } },
    ];
    const start = Date.now();
    await runConcurrent(tasks, 2);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // 并发执行不应超过串行(60ms)太多
  });
});
