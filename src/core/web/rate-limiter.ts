/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * QPS 限流器（W8.10 / DESIGN §M12.6）
 *
 * 令牌桶（Token Bucket）实现：
 * - capacity 个令牌
 * - 按 refillPerSec 速率补充令牌（连续补充）
 * - tryAcquire() 非阻塞；acquire() 异步等待直到拿到令牌
 *
 * 设计目标：
 * - 单机内存级（VSCode extension 进程内）
 * - 无定时器（按调用时机按需推进），单测易
 * - 注入 now + sleep，便于单测快速推进时间
 */

export interface RateLimiterOptions {
  /** 每秒补充多少令牌（QPS） */
  rps: number;
  /** 桶容量（默认等于 rps，允许短时小突发） */
  capacity?: number;
  /** 注入 now()，默认 Date.now */
  now?: () => number;
  /** 注入 sleep(ms)，默认 setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens: number;
  private lastRefillAt: number;

  constructor(opts: RateLimiterOptions) {
    if (opts.rps <= 0) throw new Error('RateLimiter.rps must be > 0');
    this.capacity = opts.capacity ?? opts.rps;
    this.refillPerMs = opts.rps / 1000;
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.tokens = this.capacity;
    this.lastRefillAt = this.now();
  }

  /** 当前剩余令牌（连续值，已做 refill 推进） */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** 非阻塞：有令牌则扣 1 返回 true；否则 false */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** 阻塞：等到有令牌。signal aborted 时抛错。 */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Rate limiter acquire aborted');
    // 最多循环若干次（防止 rps=极小造成极长 sleep 积累时钟偏差）
    for (let i = 0; i < 1000; i++) {
      if (this.tryAcquire()) return;
      // 计算距离下一个令牌可用的毫秒数
      const needed = 1 - this.tokens;
      const waitMs = Math.max(1, Math.ceil(needed / this.refillPerMs));
      await this.sleep(waitMs);
      if (signal?.aborted) throw new Error('Rate limiter acquire aborted');
    }
    throw new Error('Rate limiter acquire: exceeded retry budget');
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    const add = elapsed * this.refillPerMs;
    this.tokens = Math.min(this.capacity, this.tokens + add);
    this.lastRefillAt = now;
  }
}
