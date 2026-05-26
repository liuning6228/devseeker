/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ModelRouter —— 按任务特征挑 Provider + fallback 链
 *
 * 策略（MVP）：
 * 1. 显式偏好：用户在 UI 点了某 Provider → 直接用
 * 2. 必需能力：消息含图 → 必须 vision；显式 hint.needsReasoning → reasoning
 * 3. 按默认 defaultProvider 兜底
 * 4. 同货币下按成本打分（inputPrice + 3 * outputPrice）—— 简单任务走便宜的
 * 5. fallback：从候选集第一个开始；上层捕获失败后调 recordFailure() 再挑下一个
 *
 * 注意：
 * - 不做动态指标采集（留给 M12）；失败记忆仅限当前进程
 * - pick 是纯函数；副作用在 recordFailure
 */

import type { IProvider } from '../../providers/base.js';
import type { Message, ProviderId } from '../../providers/types.js';

export interface RouteHint {
  /** 显式偏好的 provider id（UI 下拉），若已注册则强制使用 */
  preferredProvider?: ProviderId;
  /** 需要 reasoning 能力（复杂编码/数学题） */
  needsReasoning?: boolean;
  /** 需要长上下文（tokens 估算） */
  minContextWindow?: number;
}

export interface RouteDecision {
  provider: IProvider;
  reason: string;
  candidates: ProviderId[];
}

export interface RouterConfig {
  providers: IProvider[];
  /** 用户在 VSCode 设置中配的 defaultProvider；不在 providers 时忽略 */
  defaultProviderId?: ProviderId;
}

/** 检查消息是否含图像 */
export function hasVisionContent(messages: Message[]): boolean {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'image_url') return true;
      }
    }
  }
  return false;
}

/**
 * W13.3-C · 判定是否应该保留 VLM OCR Policy 注入。
 *
 * 语义：一旦会话进入"含图轨道"，整个会话后续所有轮都保留 vlm_policy。
 *   - 本 turn 含图 → true
 *   - priorMessages 含图 → true
 *   - 两者都无 → false（零 token 成本）
 *
 * 与 W13.3-B 的"仅本轮含图注入"相比，这里扩展为历史持续注入，
 * 避免用户先贴图再追问文本时模型失去 OCR 规约，且让 system prompt
 * 结构在整个含图会话中保持稳定，提升 prompt-cache 命中率。
 *
 * 是纯函数，无副作用，便于单测。
 */
export function shouldKeepVisionPolicy(
  thisTurnImages: readonly string[] | undefined,
  priorMessages: Message[],
): boolean {
  if (thisTurnImages && thisTurnImages.length > 0) return true;
  return hasVisionContent(priorMessages);
}

/** 简易成本打分：单位归一到 CNY 粗略等价（1 USD ≈ 7 CNY）
 *  实际运行不做汇率换算，仅用于路由同货币/跨货币比较时的粗排。 */
function costScore(provider: IProvider): number {
  const p = provider.pricing;
  const rate = p.currency === 'USD' ? 7 : 1;
  return (p.inputPerMillion + 3 * p.outputPerMillion) * rate;
}

export class ModelRouter {
  private providers: IProvider[];
  private defaultProviderId: ProviderId | undefined;
  /** 进程内失败计数；>= THRESHOLD 的 provider 在 pick 时降权 */
  private readonly failures = new Map<ProviderId, number>();
  private static readonly FAILURE_DEPRIORITIZE_THRESHOLD = 2;

  constructor(cfg: RouterConfig) {
    this.providers = [...cfg.providers];
    this.defaultProviderId = cfg.defaultProviderId;
  }

  /** 外部热更新；panel 重建 registry 时同步调用 */
  update(cfg: RouterConfig): void {
    this.providers = [...cfg.providers];
    this.defaultProviderId = cfg.defaultProviderId;
  }

  recordFailure(id: ProviderId): void {
    this.failures.set(id, (this.failures.get(id) ?? 0) + 1);
  }

  recordSuccess(id: ProviderId): void {
    this.failures.delete(id);
  }

  /**
   * 挑一个 Provider。挑不到抛错由上层处理。
   */
  pick(input: { messages: Message[]; hint?: RouteHint }): RouteDecision | undefined {
    if (this.providers.length === 0) return undefined;

    const hint = input.hint ?? {};
    const needsVision = hasVisionContent(input.messages);

    // 1. 显式偏好（但仍要满足硬约束）
    if (hint.preferredProvider) {
      const p = this.providers.find((x) => x.id === hint.preferredProvider);
      if (p && this.meetsHardConstraints(p, { needsVision, hint })) {
        return { provider: p, reason: 'user-preferred', candidates: [p.id] };
      }
    }

    // 2. 硬能力过滤
    const feasible = this.providers.filter((p) =>
      this.meetsHardConstraints(p, { needsVision, hint }),
    );
    if (feasible.length === 0) return undefined;

    // 3. default provider 若满足，优先
    if (this.defaultProviderId) {
      const d = feasible.find((p) => p.id === this.defaultProviderId);
      if (d && !this.isDeprioritized(d.id)) {
        return { provider: d, reason: 'default', candidates: feasible.map((p) => p.id) };
      }
    }

    // 4. 失败降权 + 成本打分（升序）
    const ranked = [...feasible].sort((a, b) => {
      const depA = this.isDeprioritized(a.id) ? 1 : 0;
      const depB = this.isDeprioritized(b.id) ? 1 : 0;
      if (depA !== depB) return depA - depB;
      return costScore(a) - costScore(b);
    });

    const chosen = ranked[0];
    const reasonParts: string[] = [];
    if (needsVision) reasonParts.push('needs-vision');
    if (hint.needsReasoning) reasonParts.push('needs-reasoning');
    if (hint.minContextWindow) reasonParts.push(`min-ctx-${hint.minContextWindow}`);
    reasonParts.push('cheapest');
    return {
      provider: chosen,
      reason: reasonParts.join('+'),
      candidates: ranked.map((p) => p.id),
    };
  }

  /** 选一个不同于 failedId 的备胎 */
  pickFallback(input: {
    messages: Message[];
    hint?: RouteHint;
    failedId: ProviderId;
  }): RouteDecision | undefined {
    this.recordFailure(input.failedId);
    const remaining = this.providers.filter((p) => p.id !== input.failedId);
    if (remaining.length === 0) return undefined;

    const sub = new ModelRouter({
      providers: remaining,
      defaultProviderId:
        this.defaultProviderId === input.failedId ? undefined : this.defaultProviderId,
    });
    // 把失败历史转移，避免 fallback 选回最多失败的
    for (const [id, n] of this.failures) {
      if (id !== input.failedId) {
        for (let i = 0; i < n; i++) sub.recordFailure(id);
      }
    }
    const decision = sub.pick({ messages: input.messages, hint: input.hint });
    if (!decision) return undefined;
    return { ...decision, reason: `fallback-of-${input.failedId}|${decision.reason}` };
  }

  private meetsHardConstraints(
    p: IProvider,
    ctx: { needsVision: boolean; hint: RouteHint },
  ): boolean {
    if (ctx.needsVision && !p.capabilities.includes('vision')) return false;
    if (ctx.hint.needsReasoning && !p.capabilities.includes('reasoning')) return false;
    if (ctx.hint.minContextWindow && p.contextWindow < ctx.hint.minContextWindow) return false;
    return true;
  }

  private isDeprioritized(id: ProviderId): boolean {
    return (this.failures.get(id) ?? 0) >= ModelRouter.FAILURE_DEPRIORITIZE_THRESHOLD;
  }
}
