/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PerfProbe: 冷启动 / 首 token / Cache 命中率 压测探针
 *
 * 规约（DESIGN §W12.3 / ROADMAP B-P0-2）：
 * - 目标阈值：
 *     冷启动（activate → webview ready） ≤ 2000 ms
 *     首 token（task send → first text/reasoning delta） ≤ 3000 ms（P95）
 *     Cache 命中率（cachedTokens / promptTokens） ≥ 60%（均值）
 * - 接入点：
 *     extension.ts activate 首行       → markActivateStart()
 *     panel.ts onWebviewMessage('ready') → markWebviewReady()
 *     panel.ts runWithProvider 前      → markTaskSend(taskId)
 *     panel.ts onEvent text/reasoning_delta（首次） → markFirstDelta(taskId)
 *     panel.ts onEvent usage           → recordUsage(taskId, {...})
 *     panel.ts onEvent task_end        → markTaskEnd(taskId)
 *
 * 数据结构：
 * - 每个 task 聚合成一条 PerfTurnSample；dump() 汇总成 PerfReport
 * - 时钟：performance.now() 高精度毫秒（小数位）
 *
 * 测试与导出：
 * - VS Code 命令 `dualMind.perf.exportReport` → .dualmind/perf/perf-<ts>.json
 * - 单例导出 perfProbe；测试用 __resetPerfProbeForTest()
 */

import { performance } from 'node:perf_hooks';

export interface PerfTurnSample {
  taskId: string;
  /** task send → first token 毫秒，undefined 表示没收到首 token */
  firstTokenMs?: number;
  /** task send → task_end 毫秒 */
  totalMs?: number;
  /** usage.promptTokens */
  promptTokens?: number;
  /** usage.cachedTokens（DeepSeek prompt_cache_hit_tokens / OpenAI cached_tokens） */
  cachedTokens?: number;
  /** cachedTokens / promptTokens，[0,1]；promptTokens 为 0/undefined 时为 undefined */
  cacheHitRate?: number;
  /** 样本开始 epoch ms（Date.now()）供人类读 */
  timestamp: number;
}

export interface PerfReport {
  /** activate → webview ready 毫秒；未采集完整时为 undefined */
  coldStartMs?: number;
  /** 每轮样本明细（按 send 时间顺序） */
  turns: PerfTurnSample[];
  summary: {
    turnsCount: number;
    avgFirstTokenMs?: number;
    p50FirstTokenMs?: number;
    p95FirstTokenMs?: number;
    avgCacheHitRate?: number;
    /** coldStartMs <= 2000 */
    meetsColdStart2s?: boolean;
    /** p95FirstTokenMs <= 3000 */
    meetsFirstToken3s?: boolean;
    /** avgCacheHitRate >= 0.6 */
    meetsCacheHit60pct?: boolean;
  };
  /** 报告生成的 epoch ms */
  generatedAt: number;
}

interface PendingTurn {
  taskId: string;
  sendAt: number;
  firstDeltaAt?: number;
  endAt?: number;
  promptTokens?: number;
  cachedTokens?: number;
  timestamp: number;
}

class PerfProbe {
  private activateAt?: number;
  private webviewReadyAt?: number;
  private pending = new Map<string, PendingTurn>();
  /** 已完结样本（按 markTaskEnd 顺序 append） */
  private completed: PerfTurnSample[] = [];

  markActivateStart(): void {
    if (this.activateAt === undefined) {
      this.activateAt = performance.now();
    }
  }

  markWebviewReady(): void {
    if (this.webviewReadyAt === undefined) {
      this.webviewReadyAt = performance.now();
    }
  }

  markTaskSend(taskId: string): void {
    if (!taskId) return;
    // 幂等：若同 taskId 重复调用，以首次为准
    if (this.pending.has(taskId)) return;
    this.pending.set(taskId, {
      taskId,
      sendAt: performance.now(),
      timestamp: Date.now(),
    });
  }

  markFirstDelta(taskId: string): void {
    if (!taskId) return;
    const p = this.pending.get(taskId);
    if (!p) return;
    if (p.firstDeltaAt === undefined) {
      p.firstDeltaAt = performance.now();
    }
  }

  recordUsage(taskId: string, u: { promptTokens?: number; cachedTokens?: number }): void {
    if (!taskId) return;
    const p = this.pending.get(taskId);
    if (!p) return;
    if (typeof u.promptTokens === 'number') {
      p.promptTokens = (p.promptTokens ?? 0) + u.promptTokens;
    }
    if (typeof u.cachedTokens === 'number') {
      p.cachedTokens = (p.cachedTokens ?? 0) + u.cachedTokens;
    }
  }

  markTaskEnd(taskId: string): void {
    if (!taskId) return;
    const p = this.pending.get(taskId);
    if (!p) return;
    p.endAt = performance.now();
    this.completed.push(finalizeSample(p));
    this.pending.delete(taskId);
  }

  /** 生成一次快照报告。不清空状态，可重复调用。 */
  dump(): PerfReport {
    const coldStartMs =
      this.activateAt !== undefined && this.webviewReadyAt !== undefined
        ? round2(this.webviewReadyAt - this.activateAt)
        : undefined;

    const turns = this.completed.slice();

    const firstTokens = turns
      .map((t) => t.firstTokenMs)
      .filter((v): v is number => typeof v === 'number');
    const hitRates = turns
      .map((t) => t.cacheHitRate)
      .filter((v): v is number => typeof v === 'number');

    const avgFirstTokenMs = firstTokens.length > 0 ? round2(avg(firstTokens)) : undefined;
    const p50FirstTokenMs = firstTokens.length > 0 ? round2(percentile(firstTokens, 0.5)) : undefined;
    const p95FirstTokenMs = firstTokens.length > 0 ? round2(percentile(firstTokens, 0.95)) : undefined;
    const avgCacheHitRate = hitRates.length > 0 ? round4(avg(hitRates)) : undefined;

    const meetsColdStart2s = coldStartMs !== undefined ? coldStartMs <= 2000 : undefined;
    const meetsFirstToken3s =
      p95FirstTokenMs !== undefined ? p95FirstTokenMs <= 3000 : undefined;
    const meetsCacheHit60pct =
      avgCacheHitRate !== undefined ? avgCacheHitRate >= 0.6 : undefined;

    const summary: PerfReport['summary'] = {
      turnsCount: turns.length,
    };
    if (avgFirstTokenMs !== undefined) summary.avgFirstTokenMs = avgFirstTokenMs;
    if (p50FirstTokenMs !== undefined) summary.p50FirstTokenMs = p50FirstTokenMs;
    if (p95FirstTokenMs !== undefined) summary.p95FirstTokenMs = p95FirstTokenMs;
    if (avgCacheHitRate !== undefined) summary.avgCacheHitRate = avgCacheHitRate;
    if (meetsColdStart2s !== undefined) summary.meetsColdStart2s = meetsColdStart2s;
    if (meetsFirstToken3s !== undefined) summary.meetsFirstToken3s = meetsFirstToken3s;
    if (meetsCacheHit60pct !== undefined) summary.meetsCacheHit60pct = meetsCacheHit60pct;

    const report: PerfReport = {
      turns,
      summary,
      generatedAt: Date.now(),
    };
    if (coldStartMs !== undefined) report.coldStartMs = coldStartMs;
    return report;
  }

  /** 清空所有采样（不常用；export 后若想开新一轮可调用） */
  reset(): void {
    this.activateAt = undefined;
    this.webviewReadyAt = undefined;
    this.pending.clear();
    this.completed = [];
  }
}

function finalizeSample(p: PendingTurn): PerfTurnSample {
  const out: PerfTurnSample = {
    taskId: p.taskId,
    timestamp: p.timestamp,
  };
  if (p.firstDeltaAt !== undefined) {
    out.firstTokenMs = round2(p.firstDeltaAt - p.sendAt);
  }
  if (p.endAt !== undefined) {
    out.totalMs = round2(p.endAt - p.sendAt);
  }
  if (typeof p.promptTokens === 'number') {
    out.promptTokens = p.promptTokens;
  }
  if (typeof p.cachedTokens === 'number') {
    out.cachedTokens = p.cachedTokens;
  }
  if (typeof p.promptTokens === 'number' && p.promptTokens > 0) {
    const cached = p.cachedTokens ?? 0;
    out.cacheHitRate = round4(cached / p.promptTokens);
  }
  return out;
}

function avg(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * 线性插值分位数（nearest-rank 的平滑版）：
 * - xs 非空
 * - q ∈ [0,1]
 */
function percentile(xs: readonly number[], q: number): number {
  const sorted = xs.slice().sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 1) return sorted[0]!;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export const perfProbe = new PerfProbe();

/** 测试专用：清空全局单例 */
export function __resetPerfProbeForTest(): void {
  perfProbe.reset();
}
