/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * BudgetGuard（DESIGN §M16.4）
 *
 * 职责：
 * - 基于配置（daily / monthly 预算 + 告警档位 + 硬停比例）判断是否允许新请求
 * - 由 CostTracker 的 `todayCost()`、`serializeTotal()` 驱动
 * - 告警档位去重（同档位当日只告一次）
 *
 * MVP：
 * - 只看当日 `todayCost()`，monthly 预留（hook 出来，后续可接月度 sink）
 * - hardStopAt 是相对 daily 的比例（例如 1.2 表示 120%）
 * - alertAt 是升序档位（0.5/0.8/1.0），每当越过一档触发回调
 * - 币种：单币种预算（默认 CNY），超过用 threshold 币种比较
 *
 * 调用时机：
 * - 主循环 call LLM 之前 `canProceed()` → { ok, reason? }
 * - 每次 `notifyCost(now)` 让 Guard 拉最新 today 并评估
 */

import type { CostTracker } from './tracker.js';

export interface BudgetConfig {
  /** 单日预算（正数才启用硬停/告警；<=0 表示无限制） */
  daily?: number;
  /** 月度预算（预留；MVP 不强约束） */
  monthly?: number;
  /** 单位（默认 CNY） */
  currency?: 'CNY' | 'USD';
  /**
   * 告警档位（单调升序，范围 0~1）。
   * 例 `[0.5, 0.8, 1.0]` — 跨越阈值时触发 alert 回调。
   */
  alertAt?: number[];
  /**
   * 硬停比例（> 0 启用；daily * hardStopAt 作为绝对上限）。
   * 例 `1.2` 表示超过日预算 120% 拒绝新请求。
   */
  hardStopAt?: number;
}

export interface BudgetDecision {
  ok: boolean;
  /** today 当前值 */
  today: number;
  /** 绝对 hardStop 阈值（daily * hardStopAt） */
  hardStopAbs?: number;
  /** 拒绝时的原因码 */
  reason?: 'hard_stop' | 'no_budget_config';
  /** 人类可读消息（用于 UI 弹提示） */
  message?: string;
}

export interface BudgetAlert {
  /** 档位数值（例如 0.5 / 0.8 / 1.0） */
  threshold: number;
  /** 档位对应的绝对金额（daily * threshold） */
  absolute: number;
  /** 触发时的今日累计值 */
  today: number;
  currency: 'CNY' | 'USD';
}

export type BudgetAlertSink = (alert: BudgetAlert) => void;

/**
 * BudgetGuard：封装预算计算，不修改 CostTracker。
 * 线程模型：单线程串行调用；越档告警内部记忆。
 */
export class BudgetGuard {
  private readonly tracker: CostTracker;
  private readonly cfg: Required<Omit<BudgetConfig, 'daily' | 'monthly'>> &
    Pick<BudgetConfig, 'daily' | 'monthly'>;
  private readonly firedAlerts = new Set<number>();
  private alertSink: BudgetAlertSink | undefined;

  constructor(tracker: CostTracker, cfg: BudgetConfig = {}) {
    this.tracker = tracker;
    this.cfg = {
      currency: cfg.currency ?? 'CNY',
      alertAt: normalizeAlertAt(cfg.alertAt ?? [0.5, 0.8, 1.0]),
      hardStopAt: cfg.hardStopAt ?? 0,
      ...(cfg.daily !== undefined ? { daily: cfg.daily } : {}),
      ...(cfg.monthly !== undefined ? { monthly: cfg.monthly } : {}),
    };
  }

  setAlertSink(sink: BudgetAlertSink | undefined): void {
    this.alertSink = sink;
  }

  /** 调用前检查是否可继续（硬停 & 无预算配置时直接放行） */
  canProceed(): BudgetDecision {
    const today = this.tracker.todayCost()[this.cfg.currency];
    const daily = this.cfg.daily ?? 0;
    if (daily <= 0) {
      return { ok: true, today, reason: 'no_budget_config' };
    }
    const hardStopAbs =
      this.cfg.hardStopAt > 0 ? round6(daily * this.cfg.hardStopAt) : undefined;
    if (hardStopAbs !== undefined && today >= hardStopAbs) {
      return {
        ok: false,
        today,
        hardStopAbs,
        reason: 'hard_stop',
        message: `今日用量 ${fmt(today)} 已达硬停阈值 ${fmt(hardStopAbs)}（${this.cfg.currency}）`,
      };
    }
    return { ok: true, today, ...(hardStopAbs !== undefined ? { hardStopAbs } : {}) };
  }

  /**
   * 在每次 `record` 后调用：检查 today 是否刚越过告警档位，触发回调。
   * 若 daily 未配置或 <= 0，不告警。
   */
  notifyCost(): BudgetAlert[] {
    const daily = this.cfg.daily ?? 0;
    if (daily <= 0) return [];
    const today = this.tracker.todayCost()[this.cfg.currency];
    const fired: BudgetAlert[] = [];
    for (const threshold of this.cfg.alertAt) {
      if (this.firedAlerts.has(threshold)) continue;
      const absolute = round6(daily * threshold);
      if (today >= absolute) {
        const alert: BudgetAlert = {
          threshold,
          absolute,
          today,
          currency: this.cfg.currency,
        };
        this.firedAlerts.add(threshold);
        fired.push(alert);
        if (this.alertSink) {
          try {
            this.alertSink(alert);
          } catch {
            /* ignore sink errors */
          }
        }
      }
    }
    return fired;
  }

  /** 跨天重置告警（每日 00:00 由调度侧调一次，或 hydrateTodayFrom 后） */
  resetDaily(): void {
    this.firedAlerts.clear();
  }

  /** 返回当前快照 —— UI 可读 */
  snapshot(): {
    daily?: number;
    currency: 'CNY' | 'USD';
    today: number;
    hardStopAbs?: number;
    alertAt: number[];
    firedAlerts: number[];
  } {
    const daily = this.cfg.daily;
    const today = this.tracker.todayCost()[this.cfg.currency];
    const hardStopAbs =
      daily !== undefined && daily > 0 && this.cfg.hardStopAt > 0
        ? round6(daily * this.cfg.hardStopAt)
        : undefined;
    return {
      ...(daily !== undefined ? { daily } : {}),
      currency: this.cfg.currency,
      today,
      ...(hardStopAbs !== undefined ? { hardStopAbs } : {}),
      alertAt: [...this.cfg.alertAt],
      firedAlerts: [...this.firedAlerts].sort((a, b) => a - b),
    };
  }
}

function normalizeAlertAt(arr: number[]): number[] {
  const cleaned = arr
    .filter((n) => typeof n === 'number' && n > 0 && n <= 10)
    .sort((a, b) => a - b);
  return Array.from(new Set(cleaned));
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function fmt(n: number): string {
  if (n < 0.01) return n.toFixed(5);
  if (n < 1) return n.toFixed(4);
  return n.toFixed(3);
}
