/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CostTracker —— 按 Provider 累计 token 消耗与成本
 *
 * 职责：
 * - 接入 StreamEvent.usage → 按 pricing 计算成本（CNY / USD 分别累计）
 * - 支持 session / total 两级聚合
 * - 成本数值保留 6 位小数（足够追踪微小 prompt）
 *
 * 设计：
 * - 不做持久化（交给 SessionStore）
 * - 不关心 provider 是否在 registry —— 直接吃 pricing
 * - 所有方法同步；浮点加总（小数位粒度足够避免累计误差）
 */

import type { Pricing, ProviderId } from '../../providers/types.js';
import type { CostSink, IUsageRecord, UsageOperation } from './types.js';
import { todayStartMs } from './usage-store.js';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('cost.tracker');

export interface UsageDelta {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
}

export interface ProviderCost {
  providerId: ProviderId;
  currency: 'CNY' | 'USD';
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  calls: number;
}

export interface CostSummary {
  session: {
    CNY: number;
    USD: number;
    promptTokens: number;
    completionTokens: number;
    calls: number;
  };
  total: {
    CNY: number;
    USD: number;
    promptTokens: number;
    completionTokens: number;
    calls: number;
  };
  byProvider: ProviderCost[];
}

interface ProviderAccumulator extends ProviderCost {}

export interface CostTrackerInit {
  /** 持久化的 total（进程启动时从 workspaceState 恢复） */
  initialTotalByProvider?: ProviderCost[];
  /** 可选的 sink：每次 record 后同步 append（例如 UsageJsonlStore） */
  sink?: CostSink;
  /** 今日累计成本初始值（CNY/USD），用于 UI 状态栏恢复 */
  initialTodayByCurrency?: { CNY: number; USD: number };
}

export class CostTracker {
  private readonly session = new Map<ProviderId, ProviderAccumulator>();
  private readonly total = new Map<ProviderId, ProviderAccumulator>();
  private readonly today = { CNY: 0, USD: 0 };
  private sink: CostSink | undefined;

  constructor(init?: CostTrackerInit) {
    if (init?.initialTotalByProvider) {
      for (const entry of init.initialTotalByProvider) {
        this.total.set(entry.providerId, { ...entry });
      }
    }
    if (init?.initialTodayByCurrency) {
      this.today.CNY = init.initialTodayByCurrency.CNY;
      this.today.USD = init.initialTodayByCurrency.USD;
    }
    this.sink = init?.sink;
  }

  /** 运行期注入 / 替换 sink（例如 panel 启动后才拿到 workspaceRoot） */
  setSink(sink: CostSink | undefined): void {
    this.sink = sink;
  }

  /**
   * 记录一次 usage。
   * 成本 = (prompt - cached) * inputPrice + cached * cachedPrice + completion * outputPrice
   * 单位：元（pricing 的单价是 per 1M tokens）
   *
   * 同步累积到 session/total/today；异步 append 到 sink（失败吞）。
   */
  record(
    providerId: ProviderId,
    usage: UsageDelta,
    pricing: Pricing,
    ctx?: { sessionId?: string; turnId?: string; operation?: UsageOperation; model?: string },
  ): ProviderCost {
    const prompt = Math.max(0, Math.floor(usage.promptTokens));
    const completion = Math.max(0, Math.floor(usage.completionTokens));
    const cached = Math.max(0, Math.floor(usage.cachedTokens ?? 0));
    const uncached = Math.max(0, prompt - cached);

    const cachedPrice = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
    const cost =
      (uncached * pricing.inputPerMillion) / 1_000_000 +
      (cached * cachedPrice) / 1_000_000 +
      (completion * pricing.outputPerMillion) / 1_000_000;

    const round = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

    const existingSession = this.session.get(providerId);
    const nextSession: ProviderAccumulator = {
      providerId,
      currency: pricing.currency,
      promptTokens: (existingSession?.promptTokens ?? 0) + prompt,
      completionTokens: (existingSession?.completionTokens ?? 0) + completion,
      cachedTokens: (existingSession?.cachedTokens ?? 0) + cached,
      cost: round((existingSession?.cost ?? 0) + cost),
      calls: (existingSession?.calls ?? 0) + 1,
    };
    this.session.set(providerId, nextSession);

    const existingTotal = this.total.get(providerId);
    const nextTotal: ProviderAccumulator = {
      providerId,
      currency: pricing.currency,
      promptTokens: (existingTotal?.promptTokens ?? 0) + prompt,
      completionTokens: (existingTotal?.completionTokens ?? 0) + completion,
      cachedTokens: (existingTotal?.cachedTokens ?? 0) + cached,
      cost: round((existingTotal?.cost ?? 0) + cost),
      calls: (existingTotal?.calls ?? 0) + 1,
    };
    this.total.set(providerId, nextTotal);

    this.today[pricing.currency] = round(this.today[pricing.currency] + cost);

    // 副作用：落盘（fire-and-forget，失败不影响主流程）
    if (this.sink) {
      const rec: IUsageRecord = {
        ts: Date.now(),
        provider: providerId,
        operation: ctx?.operation ?? 'chat',
        promptTokens: prompt,
        completionTokens: completion,
        cachedTokens: cached,
        cost: round(cost),
        currency: pricing.currency,
        ...(ctx?.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
        ...(ctx?.turnId !== undefined ? { turnId: ctx.turnId } : {}),
        ...(ctx?.model !== undefined ? { model: ctx.model } : {}),
      };
      void Promise.resolve(this.sink.append(rec)).catch((e: unknown) => {
        log.warn({ err: String(e) }, 'cost sink append failed; swallow');
      });
    }

    return { ...nextSession };
  }

  /**
   * 直接登记一条预成型的 IUsageRecord（DESIGN §M16.3 接口签名）。
   * 用于 search / embed / fetch 等不走 Pricing 的场景。
   */
  recordRaw(r: IUsageRecord): void {
    const round = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
    this.today[r.currency] = round(this.today[r.currency] + r.cost);
    if (this.sink) {
      void Promise.resolve(this.sink.append(r)).catch((e: unknown) => {
        log.warn({ err: String(e) }, 'cost sink append failed; swallow');
      });
    }
  }

  /** 今日累计成本（按币种） */
  todayCost(): { CNY: number; USD: number } {
    return { CNY: this.today.CNY, USD: this.today.USD };
  }

  /**
   * 从持久化 sink 回填今日成本（进程启动时调一次）。
   * 仅 CNY/USD 两币种累加；忽略非当日记录。
   */
  async hydrateTodayFrom(records: IUsageRecord[], now: number = Date.now()): Promise<void> {
    const cutoff = todayStartMs(now);
    const round = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
    this.today.CNY = 0;
    this.today.USD = 0;
    for (const r of records) {
      if (r.ts < cutoff) continue;
      this.today[r.currency] = round(this.today[r.currency] + r.cost);
    }
  }

  /** 只清会话级（total 保留） */
  resetSession(): void {
    this.session.clear();
  }

  /** 用于 SessionStore 持久化 */
  serializeTotal(): ProviderCost[] {
    return Array.from(this.total.values()).map((x) => ({ ...x }));
  }

  summary(): CostSummary {
    const sessionAgg = { CNY: 0, USD: 0, promptTokens: 0, completionTokens: 0, calls: 0 };
    for (const c of this.session.values()) {
      sessionAgg[c.currency] += c.cost;
      sessionAgg.promptTokens += c.promptTokens;
      sessionAgg.completionTokens += c.completionTokens;
      sessionAgg.calls += c.calls;
    }
    sessionAgg.CNY = Math.round(sessionAgg.CNY * 1_000_000) / 1_000_000;
    sessionAgg.USD = Math.round(sessionAgg.USD * 1_000_000) / 1_000_000;

    const totalAgg = { CNY: 0, USD: 0, promptTokens: 0, completionTokens: 0, calls: 0 };
    for (const c of this.total.values()) {
      totalAgg[c.currency] += c.cost;
      totalAgg.promptTokens += c.promptTokens;
      totalAgg.completionTokens += c.completionTokens;
      totalAgg.calls += c.calls;
    }
    totalAgg.CNY = Math.round(totalAgg.CNY * 1_000_000) / 1_000_000;
    totalAgg.USD = Math.round(totalAgg.USD * 1_000_000) / 1_000_000;

    return {
      session: sessionAgg,
      total: totalAgg,
      byProvider: Array.from(this.session.values()).map((x) => ({ ...x })),
    };
  }
}

export function formatCost(amount: number, currency: 'CNY' | 'USD'): string {
  const sym = currency === 'CNY' ? '¥' : '$';
  if (amount < 0.0001) return `${sym}0`;
  if (amount < 0.01) return `${sym}${amount.toFixed(5)}`;
  if (amount < 1) return `${sym}${amount.toFixed(4)}`;
  return `${sym}${amount.toFixed(3)}`;
}
