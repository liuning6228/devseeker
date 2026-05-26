/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C2 · Cost Panel（B-P1-6）纯函数单测
 *
 * 覆盖：
 *   1. aggregateDailySeries 按本地日分桶 + 连续 N 天 + 空桶保留
 *   2. computeCacheHitRate 空 / 无 prompt / 正常三路分支
 *   3. buildCostPanelHtml CSP 骨架 + 空态兜底 + Top-5 + escape
 */

import { describe, it, expect } from 'vitest';
import {
  aggregateDailySeries,
  computeCacheHitRate,
  buildCostPanelHtml,
  type CostPanelInput,
} from '../../src/webview/panels/cost-panel.js';
import type { IUsageRecord } from '../../src/core/cost/types.js';
import type { CostSummaryPayload } from '../../src/shared/protocol.js';

// ────────── aggregateDailySeries ──────────

describe('aggregateDailySeries', () => {
  const now = new Date(2026, 4, 2, 15, 30, 0).getTime(); // 2026-05-02 15:30 local

  it('days=0 返回空数组', () => {
    expect(aggregateDailySeries([], 0, now)).toEqual([]);
  });

  it('空记录返回 N 个零桶', () => {
    const s = aggregateDailySeries([], 3, now);
    expect(s.length).toBe(3);
    for (const p of s) {
      expect(p.costCNY).toBe(0);
      expect(p.costUSD).toBe(0);
      expect(p.calls).toBe(0);
    }
    // 最后一个桶是今天
    expect(s[2]!.date).toBe('2026-05-02');
    expect(s[0]!.date).toBe('2026-04-30');
  });

  it('跨币种累计正确', () => {
    const today0 = new Date(2026, 4, 2, 0, 0, 0).getTime();
    const records: IUsageRecord[] = [
      { ts: today0 + 1000, provider: 'p', operation: 'chat', cost: 0.5, currency: 'CNY', promptTokens: 100, cachedTokens: 40 },
      { ts: today0 + 2000, provider: 'p', operation: 'chat', cost: 0.2, currency: 'USD', promptTokens: 50, cachedTokens: 10 },
      { ts: today0 - 24 * 3600_000 + 500, provider: 'p', operation: 'chat', cost: 1, currency: 'CNY' }, // 昨天
    ];
    const s = aggregateDailySeries(records, 3, now);
    expect(s.length).toBe(3);
    expect(s[2]!.date).toBe('2026-05-02');
    expect(s[2]!.costCNY).toBeCloseTo(0.5, 6);
    expect(s[2]!.costUSD).toBeCloseTo(0.2, 6);
    expect(s[2]!.calls).toBe(2);
    expect(s[2]!.promptTokens).toBe(150);
    expect(s[2]!.cachedTokens).toBe(50);
    // 昨天那一桶是 s[1]
    expect(s[1]!.date).toBe('2026-05-01');
    expect(s[1]!.costCNY).toBeCloseTo(1, 6);
    expect(s[1]!.calls).toBe(1);
  });

  it('超出 N 天的记录被忽略', () => {
    const today0 = new Date(2026, 4, 2, 0, 0, 0).getTime();
    const records: IUsageRecord[] = [
      { ts: today0 - 30 * 24 * 3600_000, provider: 'p', operation: 'chat', cost: 99, currency: 'CNY' },
      { ts: today0, provider: 'p', operation: 'chat', cost: 1, currency: 'CNY' },
    ];
    const s = aggregateDailySeries(records, 7, now);
    const total = s.reduce((acc, p) => acc + p.costCNY, 0);
    expect(total).toBeCloseTo(1, 6); // 30 天前的不算
  });
});

// ────────── computeCacheHitRate ──────────

describe('computeCacheHitRate', () => {
  it('undefined / empty → undefined', () => {
    expect(computeCacheHitRate(undefined)).toBeUndefined();
    expect(computeCacheHitRate([])).toBeUndefined();
  });

  it('prompt=0 → undefined', () => {
    expect(
      computeCacheHitRate([
        { providerId: 'p', currency: 'CNY', promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0, calls: 0 },
      ]),
    ).toBeUndefined();
  });

  it('跨 provider 汇总', () => {
    const rate = computeCacheHitRate([
      { providerId: 'a', currency: 'CNY', promptTokens: 100, cachedTokens: 40, completionTokens: 10, cost: 0, calls: 1 },
      { providerId: 'b', currency: 'USD', promptTokens: 100, cachedTokens: 60, completionTokens: 10, cost: 0, calls: 1 },
    ]);
    expect(rate).toBeCloseTo(0.5, 6); // (40+60)/200
  });
});

// ────────── buildCostPanelHtml ──────────

function makeInput(overrides: Partial<CostPanelInput> = {}): CostPanelInput {
  const base: CostPanelInput = {
    summary: undefined,
    dailySeries: [],
    recentRecords: [],
    totalRecords: 0,
    usageFilePath: '/home/u/.dualmind/usage.jsonl',
    cacheHitRate: undefined,
    warnings: [],
    generatedAt: '2026-05-02T10:00:00.000Z',
  };
  return { ...base, ...overrides };
}

const sampleSummary: CostSummaryPayload = {
  session: { CNY: 1.234567, USD: 0, promptTokens: 5000, completionTokens: 1000, calls: 3 },
  total: { CNY: 10.0, USD: 2.5, promptTokens: 50000, completionTokens: 10000, calls: 30 },
  today: { CNY: 1.234567, USD: 0 },
  byProvider: [
    { providerId: 'deepseek-v4', currency: 'CNY', promptTokens: 5000, completionTokens: 1000, cachedTokens: 3000, cost: 1.2, calls: 3 },
    { providerId: 'openai-5', currency: 'USD', promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, calls: 0 },
  ],
};

describe('buildCostPanelHtml', () => {
  it('CSP 骨架：nonce + cspSource + default-src none', () => {
    const html = buildCostPanelHtml(makeInput(), 'N1', 'vscode-webview://Y');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("nonce-N1");
    expect(html).toContain('vscode-webview://Y');
  });

  it('空态：summary undefined 时 KPI 展示占位符', () => {
    const html = buildCostPanelHtml(makeInput(), 'N', 'C');
    expect(html).toContain('Session');
    expect(html).toContain('Today');
    expect(html).toContain('All Time');
    expect(html).toContain('Cache Hit');
    expect(html).toContain('n/a'); // cache hit rate 文案
    expect(html).toContain('(no provider usage yet in current session)');
    expect(html).toContain('(no history)'); // daily series
    expect(html).toContain('(no records'); // recent usage
  });

  it('有 summary：Top-5 按 cost desc + cache hit 展示百分比', () => {
    const html = buildCostPanelHtml(
      makeInput({ summary: sampleSummary, cacheHitRate: 0.6 }),
      'N',
      'C',
    );
    expect(html).toContain('Top 2 Providers (session)'); // 只有 2 个
    expect(html).toContain('deepseek-v4');
    expect(html).toContain('openai-5');
    expect(html).toContain('60%'); // cache hit rate
    expect(html).toContain('pill ok'); // 60% ≥ 60% → ok
    expect(html).toContain('¥1.2346'); // formatNumber(1.234567, 4) = 1.2346
  });

  it('cache hit rate < 60% 打 warn pill', () => {
    const html = buildCostPanelHtml(
      makeInput({ summary: sampleSummary, cacheHitRate: 0.3 }),
      'N',
      'C',
    );
    expect(html).toContain('30%');
    expect(html).toContain('pill warn');
  });

  it('usageFilePath 被 escape', () => {
    const html = buildCostPanelHtml(
      makeInput({ usageFilePath: '/tmp/<inject>/usage.jsonl' }),
      'N',
      'C',
    );
    expect(html).toContain('&lt;inject&gt;');
    expect(html).not.toContain('<inject>');
  });

  it('dailySeries 非空 → 渲染 SVG polyline', () => {
    const series = aggregateDailySeries(
      [
        { ts: Date.now(), provider: 'p', operation: 'chat', cost: 1, currency: 'CNY' },
      ],
      7,
      Date.now(),
    );
    const html = buildCostPanelHtml(makeInput({ dailySeries: series }), 'N', 'C');
    expect(html).toContain('<svg');
    expect(html).toContain('<polyline');
    expect(html).toContain('Daily Cost (last 7d)');
  });

  it('warnings 数组被渲染并 escape', () => {
    const html = buildCostPanelHtml(
      makeInput({ warnings: ['usage-store: <oops>'] }),
      'N',
      'C',
    );
    expect(html).toContain('<h2>Warnings</h2>');
    expect(html).toContain('&lt;oops&gt;');
  });
});
