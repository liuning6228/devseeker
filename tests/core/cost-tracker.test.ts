/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

import { describe, it, expect } from 'vitest';
import { CostTracker, formatCost } from '../../src/core/cost/tracker.js';
import type { Pricing } from '../../src/providers/types.js';

const DEEPSEEK_PRICING: Pricing = {
  inputPerMillion: 2,
  outputPerMillion: 8,
  cachedInputPerMillion: 0.5,
  currency: 'CNY',
};

const OPENAI_PRICING: Pricing = {
  inputPerMillion: 0.15,
  outputPerMillion: 0.6,
  cachedInputPerMillion: 0.075,
  currency: 'USD',
};

describe('CostTracker', () => {
  it('records a single call and computes cost (no cache)', () => {
    const t = new CostTracker();
    const row = t.record(
      'deepseek-v4',
      { promptTokens: 1_000_000, completionTokens: 500_000 },
      DEEPSEEK_PRICING,
    );
    // 1M * 2 + 0.5M * 8 = 2 + 4 = 6
    expect(row.cost).toBeCloseTo(6, 6);
    expect(row.promptTokens).toBe(1_000_000);
    expect(row.completionTokens).toBe(500_000);
    expect(row.cachedTokens).toBe(0);
    expect(row.currency).toBe('CNY');
    expect(row.calls).toBe(1);
  });

  it('applies cached token discount', () => {
    const t = new CostTracker();
    const row = t.record(
      'deepseek-v4',
      { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 800_000 },
      DEEPSEEK_PRICING,
    );
    // 0.2M * 2 + 0.8M * 0.5 = 0.4 + 0.4 = 0.8
    expect(row.cost).toBeCloseTo(0.8, 6);
    expect(row.cachedTokens).toBe(800_000);
  });

  it('falls back to inputPrice when no cachedInputPerMillion', () => {
    const pricing: Pricing = { inputPerMillion: 2, outputPerMillion: 8, currency: 'CNY' };
    const t = new CostTracker();
    const row = t.record(
      'deepseek-v4',
      { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 500_000 },
      pricing,
    );
    // 1M * 2 (cached uses same input price) = 2
    expect(row.cost).toBeCloseTo(2, 6);
  });

  it('accumulates across calls for same provider', () => {
    const t = new CostTracker();
    t.record('deepseek-v4', { promptTokens: 100_000, completionTokens: 50_000 }, DEEPSEEK_PRICING);
    const second = t.record(
      'deepseek-v4',
      { promptTokens: 200_000, completionTokens: 100_000 },
      DEEPSEEK_PRICING,
    );
    expect(second.calls).toBe(2);
    expect(second.promptTokens).toBe(300_000);
    expect(second.completionTokens).toBe(150_000);
    // (0.1M*2 + 0.05M*8) + (0.2M*2 + 0.1M*8) = 0.6 + 1.2 = 1.8
    expect(second.cost).toBeCloseTo(1.8, 6);
  });

  it('summary separates CNY vs USD', () => {
    const t = new CostTracker();
    t.record('deepseek-v4', { promptTokens: 1_000_000, completionTokens: 0 }, DEEPSEEK_PRICING);
    t.record('openai-gpt', { promptTokens: 1_000_000, completionTokens: 0 }, OPENAI_PRICING);
    const s = t.summary();
    expect(s.session.CNY).toBeCloseTo(2, 6);
    expect(s.session.USD).toBeCloseTo(0.15, 6);
    expect(s.session.calls).toBe(2);
    expect(s.byProvider).toHaveLength(2);
  });

  it('resetSession clears session but keeps total', () => {
    const t = new CostTracker();
    t.record('deepseek-v4', { promptTokens: 1_000_000, completionTokens: 0 }, DEEPSEEK_PRICING);
    t.resetSession();
    const s = t.summary();
    expect(s.session.CNY).toBe(0);
    expect(s.session.calls).toBe(0);
    expect(s.total.CNY).toBeCloseTo(2, 6);
    expect(s.total.calls).toBe(1);
  });

  it('restores initialTotal from workspaceState', () => {
    const t = new CostTracker({
      initialTotalByProvider: [
        {
          providerId: 'deepseek-v4',
          currency: 'CNY',
          promptTokens: 5_000_000,
          completionTokens: 2_000_000,
          cachedTokens: 0,
          cost: 26,
          calls: 10,
        },
      ],
    });
    t.record('deepseek-v4', { promptTokens: 1_000_000, completionTokens: 0 }, DEEPSEEK_PRICING);
    const s = t.summary();
    expect(s.total.CNY).toBeCloseTo(28, 6); // 26 + 2
    expect(s.total.calls).toBe(11);
    expect(s.session.calls).toBe(1); // session 仅算本次
  });

  it('serializeTotal returns snapshot for persistence', () => {
    const t = new CostTracker();
    t.record('deepseek-v4', { promptTokens: 1_000_000, completionTokens: 0 }, DEEPSEEK_PRICING);
    const dump = t.serializeTotal();
    expect(dump).toHaveLength(1);
    expect(dump[0].providerId).toBe('deepseek-v4');
    expect(dump[0].cost).toBeCloseTo(2, 6);
  });

  it('clamps negative usage to 0', () => {
    const t = new CostTracker();
    const row = t.record(
      'deepseek-v4',
      { promptTokens: -10, completionTokens: -20 },
      DEEPSEEK_PRICING,
    );
    expect(row.promptTokens).toBe(0);
    expect(row.completionTokens).toBe(0);
    expect(row.cost).toBe(0);
  });
});

describe('formatCost', () => {
  it('returns zero string when amount < 0.0001', () => {
    expect(formatCost(0, 'CNY')).toBe('¥0');
    expect(formatCost(0.00001, 'USD')).toBe('$0');
  });
  it('uses 5 decimals for very small', () => {
    expect(formatCost(0.001, 'CNY')).toBe('¥0.00100');
  });
  it('uses 4 decimals for small', () => {
    expect(formatCost(0.1, 'USD')).toBe('$0.1000');
  });
  it('uses 3 decimals for regular', () => {
    expect(formatCost(12.3456, 'CNY')).toBe('¥12.346');
  });
});

// ═══════════════════════ W7b3 extensions ═══════════════════════

import type { CostSink, IUsageRecord } from '../../src/core/cost/types.js';

class MemorySink implements CostSink {
  readonly records: IUsageRecord[] = [];
  async append(r: IUsageRecord): Promise<void> {
    this.records.push(r);
  }
}

describe('CostTracker · W7b3 today + sink', () => {
  it('todayCost accumulates across calls and per currency', () => {
    const t = new CostTracker();
    t.record('deepseek-v4', { promptTokens: 1_000_000, completionTokens: 0 }, DEEPSEEK_PRICING);
    t.record('openai-5', { promptTokens: 1_000_000, completionTokens: 0 }, OPENAI_PRICING);
    const today = t.todayCost();
    expect(today.CNY).toBeCloseTo(2, 6);
    expect(today.USD).toBeCloseTo(0.15, 6);
  });

  it('sink receives append on record with correct fields', async () => {
    const sink = new MemorySink();
    const t = new CostTracker({ sink });
    t.record(
      'deepseek-v4',
      { promptTokens: 500_000, completionTokens: 100_000 },
      DEEPSEEK_PRICING,
      { sessionId: 'sess-1', turnId: 't-1', operation: 'chat' },
    );
    // fire-and-forget: wait microtask
    await Promise.resolve();
    expect(sink.records).toHaveLength(1);
    const r = sink.records[0]!;
    expect(r.provider).toBe('deepseek-v4');
    expect(r.operation).toBe('chat');
    expect(r.sessionId).toBe('sess-1');
    expect(r.turnId).toBe('t-1');
    expect(r.currency).toBe('CNY');
    expect(r.promptTokens).toBe(500_000);
    expect(r.cost).toBeGreaterThan(0);
  });

  it('setSink replaces sink at runtime', async () => {
    const sink1 = new MemorySink();
    const sink2 = new MemorySink();
    const t = new CostTracker({ sink: sink1 });
    t.record('deepseek-v4', { promptTokens: 1000, completionTokens: 0 }, DEEPSEEK_PRICING);
    await Promise.resolve();
    t.setSink(sink2);
    t.record('deepseek-v4', { promptTokens: 1000, completionTokens: 0 }, DEEPSEEK_PRICING);
    await Promise.resolve();
    expect(sink1.records).toHaveLength(1);
    expect(sink2.records).toHaveLength(1);
  });

  it('sink failure does not throw from record', async () => {
    const badSink: CostSink = {
      append(): Promise<void> {
        return Promise.reject(new Error('disk full'));
      },
    };
    const t = new CostTracker({ sink: badSink });
    expect(() =>
      t.record('deepseek-v4', { promptTokens: 100, completionTokens: 0 }, DEEPSEEK_PRICING),
    ).not.toThrow();
    // 微任务队列异常被吞
    await new Promise((r) => setTimeout(r, 0));
  });

  it('hydrateTodayFrom sums only same-day records', async () => {
    const t = new CostTracker();
    const now = Date.now();
    const todayStart = new Date(now);
    todayStart.setHours(12, 0, 0, 0);
    const yesterday = todayStart.getTime() - 24 * 3600 * 1000;
    const records: IUsageRecord[] = [
      { ts: yesterday, provider: 'deepseek-v4', operation: 'chat', cost: 100, currency: 'CNY' },
      { ts: todayStart.getTime(), provider: 'deepseek-v4', operation: 'chat', cost: 2, currency: 'CNY' },
      { ts: todayStart.getTime() + 1000, provider: 'openai-5', operation: 'chat', cost: 0.3, currency: 'USD' },
    ];
    await t.hydrateTodayFrom(records, now);
    const today = t.todayCost();
    expect(today.CNY).toBeCloseTo(2, 6);
    expect(today.USD).toBeCloseTo(0.3, 6);
  });

  it('recordRaw accumulates today without pricing lookup', async () => {
    const sink = new MemorySink();
    const t = new CostTracker({ sink });
    t.recordRaw({
      ts: Date.now(),
      provider: 'tavily',
      operation: 'search',
      cost: 0.001,
      currency: 'USD',
    });
    await Promise.resolve();
    expect(t.todayCost().USD).toBeCloseTo(0.001, 6);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]!.operation).toBe('search');
  });
});

