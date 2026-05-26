/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W10.5 · BudgetGuard 单测
 *
 * 覆盖：
 * - daily 未配置 → canProceed 放行（no_budget_config）
 * - hardStopAt 达标 → canProceed.ok=false
 * - 告警档位越过 → notifyCost 触发；同档位不重复触发
 * - resetDaily → 清空已触发档位
 * - snapshot 返回配置快照
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { CostTracker } from '../../src/core/cost/tracker.js';
import { BudgetGuard, type BudgetAlert } from '../../src/core/cost/budget.js';
import type { Pricing } from '../../src/providers/types.js';
import { initLogger } from '../../src/infra/logger.js';

const CNY_1_PER_MTOK: Pricing = {
  inputPerMillion: 1_000_000,
  outputPerMillion: 1_000_000,
  currency: 'CNY',
};

beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
});

function newTracker(): CostTracker {
  return new CostTracker();
}

describe('BudgetGuard.canProceed', () => {
  it('returns ok=true with reason=no_budget_config when daily not set', () => {
    const tracker = newTracker();
    const guard = new BudgetGuard(tracker, {});
    const d = guard.canProceed();
    expect(d.ok).toBe(true);
    expect(d.reason).toBe('no_budget_config');
  });

  it('enforces hardStop when today >= daily * hardStopAt', () => {
    const tracker = newTracker();
    const guard = new BudgetGuard(tracker, {
      daily: 10,
      currency: 'CNY',
      hardStopAt: 1.2,
    });
    // 喂 15 元（记 15 token * 1 元/token = 15 元；因为 inputPerMillion=1e6 → 1 token = 1 元）
    tracker.record('deepseek', { promptTokens: 15, completionTokens: 0 }, CNY_1_PER_MTOK);
    const d = guard.canProceed();
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('hard_stop');
    expect(d.hardStopAbs).toBe(12);
    expect(d.today).toBe(15);
    expect(d.message).toContain('硬停');
  });

  it('allows when today < hardStopAbs', () => {
    const tracker = newTracker();
    const guard = new BudgetGuard(tracker, {
      daily: 10,
      currency: 'CNY',
      hardStopAt: 1.2,
    });
    tracker.record('deepseek', { promptTokens: 5, completionTokens: 0 }, CNY_1_PER_MTOK);
    const d = guard.canProceed();
    expect(d.ok).toBe(true);
    expect(d.today).toBe(5);
    expect(d.hardStopAbs).toBe(12);
  });
});

describe('BudgetGuard.notifyCost', () => {
  it('fires each threshold once when crossed', () => {
    const tracker = newTracker();
    const fired: BudgetAlert[] = [];
    const guard = new BudgetGuard(tracker, {
      daily: 10,
      currency: 'CNY',
      alertAt: [0.5, 0.8, 1.0],
    });
    guard.setAlertSink((a) => fired.push(a));

    // 喂 3 → 30% → 无告警
    tracker.record('deepseek', { promptTokens: 3, completionTokens: 0 }, CNY_1_PER_MTOK);
    expect(guard.notifyCost()).toEqual([]);

    // 再喂 3 → 60% → 触发 0.5
    tracker.record('deepseek', { promptTokens: 3, completionTokens: 0 }, CNY_1_PER_MTOK);
    const r1 = guard.notifyCost();
    expect(r1.map((a) => a.threshold)).toEqual([0.5]);

    // 再喂 3 → 90% → 触发 0.8
    tracker.record('deepseek', { promptTokens: 3, completionTokens: 0 }, CNY_1_PER_MTOK);
    const r2 = guard.notifyCost();
    expect(r2.map((a) => a.threshold)).toEqual([0.8]);

    // 再喂 2 → 110% → 触发 1.0
    tracker.record('deepseek', { promptTokens: 2, completionTokens: 0 }, CNY_1_PER_MTOK);
    const r3 = guard.notifyCost();
    expect(r3.map((a) => a.threshold)).toEqual([1.0]);

    // 再喂 → 无重复告警
    tracker.record('deepseek', { promptTokens: 1, completionTokens: 0 }, CNY_1_PER_MTOK);
    expect(guard.notifyCost()).toEqual([]);

    expect(fired.map((a) => a.threshold)).toEqual([0.5, 0.8, 1.0]);
  });

  it('fires multiple thresholds in single notify when jumping', () => {
    const tracker = newTracker();
    const guard = new BudgetGuard(tracker, {
      daily: 10,
      currency: 'CNY',
      alertAt: [0.5, 0.8],
    });
    tracker.record('deepseek', { promptTokens: 9, completionTokens: 0 }, CNY_1_PER_MTOK);
    const r = guard.notifyCost();
    expect(r.map((a) => a.threshold)).toEqual([0.5, 0.8]);
  });

  it('resetDaily clears fired alerts', () => {
    const tracker = newTracker();
    const guard = new BudgetGuard(tracker, {
      daily: 10,
      currency: 'CNY',
      alertAt: [0.5],
    });
    tracker.record('deepseek', { promptTokens: 6, completionTokens: 0 }, CNY_1_PER_MTOK);
    expect(guard.notifyCost().map((a) => a.threshold)).toEqual([0.5]);
    expect(guard.notifyCost()).toEqual([]);
    guard.resetDaily();
    expect(guard.notifyCost().map((a) => a.threshold)).toEqual([0.5]);
  });

  it('no alerts when daily not configured', () => {
    const tracker = newTracker();
    const guard = new BudgetGuard(tracker, { alertAt: [0.5] });
    tracker.record('deepseek', { promptTokens: 100, completionTokens: 0 }, CNY_1_PER_MTOK);
    expect(guard.notifyCost()).toEqual([]);
  });
});

describe('BudgetGuard.snapshot', () => {
  it('reflects configured daily + currency + fired alerts', () => {
    const tracker = newTracker();
    const guard = new BudgetGuard(tracker, {
      daily: 10,
      currency: 'CNY',
      alertAt: [0.5, 0.8],
      hardStopAt: 1.2,
    });
    tracker.record('deepseek', { promptTokens: 6, completionTokens: 0 }, CNY_1_PER_MTOK);
    guard.notifyCost();
    const snap = guard.snapshot();
    expect(snap.daily).toBe(10);
    expect(snap.currency).toBe('CNY');
    expect(snap.today).toBe(6);
    expect(snap.hardStopAbs).toBe(12);
    expect(snap.alertAt).toEqual([0.5, 0.8]);
    expect(snap.firedAlerts).toEqual([0.5]);
  });
});
