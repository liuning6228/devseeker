/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Cache Boundary Hashing（DESIGN §M3.6 · W3.6）+ 滚动前缀缓存（§8.17.1）
 *
 * 提供**层级前缀哈希**便于：
 * 1. 单测断言 L0/L1/L2 的变更隔离性
 * 2. 运行时可观测缓存命中率
 * 3. Provider 侧的 prompt_cache_hit_tokens 交叉验证
 *
 * §8.17.1 RollingPrefixCache：
 * - 在 TaskLoop 生命周期内缓存上次构建的 L0/L1/L2 的 join 结果
 * - 连续两轮 L0/L1/L2 字节级相同时复用 full 字符串
 * - 按 mode 隔离，避免不同 mode 串扰
 *
 * 设计要点：
 * - 使用 SHA-256 并截短为 16 hex（64-bit）——碰撞概率对调试完全够用
 * - 哈希 UTF-8 字节，避免平台差异
 * - 拼接分隔符固定 `\n\n`，与 PromptBuilder.full 内部使用保持一致
 */

import { createHash } from 'node:crypto';
import type { LayeredPrompt } from './builder.js';

const SEP = '\n\n';

/** 对任意字符串计算短 SHA-256 前缀 */
export function computeCacheKey(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

export interface LayerCacheKeys {
  /** 仅 L0 的哈希（永不变的基线） */
  L0: string;
  /** L0 + L1 拼接的哈希（mode/skills 层前缀） */
  L0L1: string;
  /** L0 + L1 + L2 拼接的哈希（rules/memory 层前缀） */
  L0L1L2: string;
  /** 完整 system prompt 的哈希（含 L3） */
  full: string;
}

/**
 * 计算分层前缀哈希。
 *
 * 实现细节：当某层为空串时，前缀**不追加 SEP**（与 PromptBuilder.full 的
 * `.filter(s => s && s.length > 0).join(SEP)` 行为保持一致），这样保证
 * 「空 L1 + 非空 L2」和「无 L1、直接 L2」产生相同的 L0L1 哈希。
 */
export function computeLayerCacheKeys(p: Pick<LayeredPrompt, 'L0' | 'L1' | 'L2' | 'full'>): LayerCacheKeys {
  const prefixL0 = p.L0;
  const prefixL0L1 = p.L1.length > 0 ? `${prefixL0}${SEP}${p.L1}` : prefixL0;
  const prefixL0L1L2 = p.L2.length > 0 ? `${prefixL0L1}${SEP}${p.L2}` : prefixL0L1;
  return {
    L0: computeCacheKey(prefixL0),
    L0L1: computeCacheKey(prefixL0L1),
    L0L1L2: computeCacheKey(prefixL0L1L2),
    full: computeCacheKey(p.full),
  };
}

// ─────────── §8.17.1 · 滚动前缀缓存 ───────────

/**
 * 快速非加密哈希（FNV-1a 64-bit 变体）。
 * 输入：各层完整字符串（1-100KB）。冲突概率在单 TaskLoop 内可忽略（~2^-64）。
 */
function fastHash(str: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash *= 0x100000001b3n;
    hash &= 0xffffffffffffffffn; // 64-bit
  }
  return hash.toString(36);
}

/**
 * 滚动前缀缓存 —— 在 PromptBuilder 生命周期内缓存上一次的各层内容。
 *
 * 设计要点：
 * - 仅在 TaskLoop 生命周期内有效（一次 send() 调用的多次 build）
 * - 按 mode 维度隔离，避免不同 mode 的 cache 串扰
 * - 缓存 key = `${mode}:${version}:${h0}:${h1}:${h2}`
 * - 命中时直接返回上一次的 full 字符串的引用
 */
export class RollingPrefixCache {
  private cache = new Map<string, string>();

  /** 命中次数统计 */
  hitCount = 0;
  /** 未命中次数统计 */
  missCount = 0;

  /**
   * 查找缓存。命中则返回上一轮的 full 字符串引用；
   * 未命中返回 undefined。
   */
  get(mode: string, version: string, L0: string, L1: string, L2: string): string | undefined {
    const key = mkCacheKey(mode, version, L0, L1, L2);
    return this.cache.get(key);
  }

  /**
   * 写入缓存。在构建完成后调用。
   */
  set(mode: string, version: string, L0: string, L1: string, L2: string, full: string): void {
    const key = mkCacheKey(mode, version, L0, L1, L2);
    this.cache.set(key, full);
  }

  /** 清除全部缓存（TaskLoop send() 结束时调用） */
  clear(): void {
    this.cache.clear();
  }
}

function mkCacheKey(mode: string, version: string, L0: string, L1: string, L2: string): string {
  return `${mode}|${version}|${fastHash(L0)}|${fastHash(L1)}|${fastHash(L2)}`;
}
