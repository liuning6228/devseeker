/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ApiKeyPool —— 多 API Key 管理池
 *
 * 功能：
 * - 支持配置多个 API Key（最多 30+）
 * - 随机选择可用 Key 进行调用
 * - Key 调用失败时自动 failover 到其他 Key
 * - 连续多次失败的 Key 自动标记为失效（deactivated）
 * - 失效 Key 不再参与随机选择
 * - 支持手动重新激活失效 Key
 *
 * 配置方式：
 * - devSeeker.webResearch.tavily.apiKeys（逗号分隔的多 key 字符串）
 * - devSeeker.webResearch.bocha.apiKeys
 * - 优先使用 apiKeys（多 key），回退到 apiKey（单 key）
 */

import { getLogger } from '../../infra/logger.js';

const log = getLogger('api-key-pool');

/** 连续失败多少次后自动失效 Key */
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

interface KeyEntry {
  readonly key: string;
  /** 连续失败计数 */
  consecutiveFailures: number;
  /** 是否已失效 */
  deactivated: boolean;
  /** 总调用次数 */
  totalCalls: number;
  /** 总失败次数 */
  totalFailures: number;
}

export class ApiKeyPool {
  private readonly keys: KeyEntry[] = [];
  private readonly maxConsecutiveFailures: number;

  constructor(
    keys: string[],
    maxConsecutiveFailures: number = DEFAULT_MAX_CONSECUTIVE_FAILURES,
  ) {
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    for (const key of keys) {
      const trimmed = key.trim();
      if (trimmed) {
        this.keys.push({
          key: trimmed,
          consecutiveFailures: 0,
          deactivated: false,
          totalCalls: 0,
          totalFailures: 0,
        });
      }
    }
  }

  /** 是否有可用的 Key */
  hasAvailableKeys(): boolean {
    return this.keys.some((k) => !k.deactivated);
  }

  /** 获取 Key 总数 */
  get totalKeys(): number {
    return this.keys.length;
  }

  /** 获取可用 Key 数量 */
  get availableKeyCount(): number {
    return this.keys.filter((k) => !k.deactivated).length;
  }

  /** 获取已失效 Key 数量 */
  get deactivatedKeyCount(): number {
    return this.keys.filter((k) => k.deactivated).length;
  }

  /**
   * 随机选择一个可用的 Key。
   * 如果没有可用 Key，返回 undefined。
   */
  pick(): string | undefined {
    const available = this.keys.filter((k) => !k.deactivated);
    if (available.length === 0) {
      log.warn({ total: this.keys.length, deactivated: this.deactivatedKeyCount }, 'ApiKeyPool: no available keys');
      return undefined;
    }
    // 随机选择
    const entry = available[Math.floor(Math.random() * available.length)];
    entry.totalCalls++;
    return entry.key;
  }

  /**
   * 报告 Key 调用成功，重置连续失败计数。
   */
  reportSuccess(key: string): void {
    const entry = this.keys.find((k) => k.key === key);
    if (entry) {
      entry.consecutiveFailures = 0;
    }
  }

  /**
   * 报告 Key 调用失败，增加连续失败计数。
   * 如果连续失败次数达到阈值，自动失效该 Key。
   * @returns 是否已达到失效阈值
   */
  reportFailure(key: string): boolean {
    const entry = this.keys.find((k) => k.key === key);
    if (!entry) return false;

    entry.consecutiveFailures++;
    entry.totalFailures++;

    if (entry.consecutiveFailures >= this.maxConsecutiveFailures && !entry.deactivated) {
      entry.deactivated = true;
      log.warn(
        { keyPrefix: key.substring(0, 8) + '...', consecutiveFailures: entry.consecutiveFailures },
        'ApiKeyPool: key deactivated due to consecutive failures',
      );
      return true;
    }
    return false;
  }

  /**
   * 重新激活所有已失效的 Key。
   * @returns 重新激活的 Key 数量
   */
  reactivateAll(): number {
    let count = 0;
    for (const entry of this.keys) {
      if (entry.deactivated) {
        entry.deactivated = false;
        entry.consecutiveFailures = 0;
        count++;
      }
    }
    if (count > 0) {
      log.info({ reactivated: count }, 'ApiKeyPool: reactivated deactivated keys');
    }
    return count;
  }

  /**
   * 向池中追加新的 Key（供「添加 Key」命令使用，即时生效无需重建 Pool）。
   * 如果 key 已存在则忽略。
   * @returns 是否成功添加（true=新增，false=已存在）
   */
  addKey(key: string): boolean {
    const trimmed = key.trim();
    if (!trimmed) return false;
    const exists = this.keys.some((k) => k.key === trimmed);
    if (exists) return false;
    this.keys.push({
      key: trimmed,
      consecutiveFailures: 0,
      deactivated: false,
      totalCalls: 0,
      totalFailures: 0,
    });
    log.info({ keyPrefix: trimmed.substring(0, 8) + '...', total: this.keys.length }, 'ApiKeyPool: new key added');
    return true;
  }

  /**
   * 获取 Key 状态概览（用于 UI 显示）
   */
  getStatus(): { total: number; available: number; deactivated: number; details: Array<{ keyPrefix: string; deactivated: boolean; consecutiveFailures: number }> } {
    return {
      total: this.keys.length,
      available: this.availableKeyCount,
      deactivated: this.deactivatedKeyCount,
      details: this.keys.map((k) => ({
        keyPrefix: k.key.substring(0, 8) + '...',
        deactivated: k.deactivated,
        consecutiveFailures: k.consecutiveFailures,
      })),
    };
  }
}

/**
 * 从 VS Code 配置中解析多 Key 字符串。
 * 支持逗号分隔、分号分隔、换行分隔。
 * 空字符串返回空数组。
 */
export function parseApiKeys(keysStr: string): string[] {
  if (!keysStr || !keysStr.trim()) return [];
  // 支持逗号、分号、换行作为分隔符
  return keysStr
    .split(/[,;\n]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}
