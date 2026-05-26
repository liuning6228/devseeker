/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * LatencyProbe —— 网络感知路由延迟探测器（§8.16.3）
 *
 * 职责：
 * - 使用 HTTP HEAD 请求测量 Provider API 端点的网络延迟
 * - 按 50ms / 200ms 分三档，指导 Provider 选择决策
 * - 探测结果缓存 60s，避免每次创建 Provider 都探测
 */

export type LatencyTier = 'good' | 'moderate' | 'poor';

export interface LatencyProbeResult {
  tier: LatencyTier;
  /** 实际测量延迟 ms */
  latencyMs: number;
  /** 探测时间 */
  probedAt: number;
}

export interface LatencyStrategy {
  useKeyRotation: boolean;
  preferredProvider?: string;
}

/** 延迟分档阈值（ms） */
const GOOD_THRESHOLD = 50;
const MODERATE_THRESHOLD = 200;

/**
 * 延迟探测器。
 * 使用 HTTP HEAD 做延迟测量，避免真实 API 调用成本。
 */
export class LatencyProbe {
  private cache = new Map<string, { result: LatencyProbeResult; expiresAt: number }>();
  private readonly probeTimeoutMs = 3000;
  private readonly cacheTtlMs = 60_000;

  /**
   * 对指定 URL 做延迟探测。
   * 使用 http HEAD 请求（比 TCP ping 更接近真实 API 调用延迟）。
   * 若已有有效缓存，直接返回。
   */
  async probe(url: string): Promise<LatencyProbeResult> {
    const cached = this.cache.get(url);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.result;
    }

    const start = performance.now();
    let latencyMs: number;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.probeTimeoutMs);
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timer);
      // HEAD 可能被某些服务器拒绝（405），接受非 2xx 也算延迟到了
      latencyMs = performance.now() - start;
      void response; // 不关心响应体
    } catch {
      latencyMs = this.probeTimeoutMs + 100; // 超时 → 标记 poor
    }

    const tier = latencyMs < GOOD_THRESHOLD ? 'good'
      : latencyMs < MODERATE_THRESHOLD ? 'moderate'
      : 'poor';

    const result: LatencyProbeResult = {
      tier,
      latencyMs: Math.round(latencyMs),
      probedAt: Date.now(),
    };

    this.cache.set(url, { result, expiresAt: Date.now() + this.cacheTtlMs });
    return result;
  }

  /**
   * 按分档返回对应的 Provider 策略。
   */
  decideStrategy(tier: LatencyTier): LatencyStrategy {
    switch (tier) {
      case 'good':
        return { useKeyRotation: false };
      case 'moderate':
        return { useKeyRotation: true };
      case 'poor':
        return { useKeyRotation: true, preferredProvider: 'cn-mirror' };
    }
  }

  /** 清空所有缓存 */
  clearCache(): void {
    this.cache.clear();
  }
}
