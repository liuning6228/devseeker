/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ContinuableAgentRegistry —— 可继续的子代理注册表
 *
 * 存储已完成/运行中的子代理的 resume 回调，供 SendMessageTool 使用。
 * 子代理完成后可短暂存活在此注册表中（窗口期），供主 agent "continue"。
 *
 * 注册时机：
 * - 子代理启动时：register(agentId, resumeFn)
 * - 子代理正常完成时：register(agentId, resumeFn) — 让主 agent 有机会 SendMessage
 * - 子代理超时/失败时：unregister(agentId)
 *
 * 窗口期：子代理完成后默认保留 5 分钟，超时自动清理。
 * 清理后 SendMessage 返回"未找到可继续的子代理"错误。
 *
 * DESIGN-1.md §4.8 · ROADMAP.md 方案四 Step 2
 */

import { getLogger } from '../../infra/logger.js';

const log = getLogger('subagent.continuable-registry');

/** 可继续的子代理记录 */
interface ContinuableAgentEntry {
  agentId: string;
  description: string;
  /** 恢复执行函数 */
  resume: (message: string) => Promise<{ summary: string; toolCalls: number }>;
  /** 创建时间（用于超时清理） */
  createdAt: number;
  /** 是否仍在运行（true=可接收 SendMessage，false=已完成但保持窗口期） */
  isRunning: boolean;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 分钟
const CLEANUP_INTERVAL_MS = 60_000; // 每分钟清理一次

class ContinuableAgentRegistryImpl {
  private agents = new Map<string, ContinuableAgentEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    // 启动后台清理
    this.cleanupTimer = setInterval(() => this.evictStale(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  /** 注册可继续的子代理 */
  register(
    agentId: string,
    resume: (message: string) => Promise<{ summary: string; toolCalls: number }>,
    description: string,
    isRunning: boolean,
  ): void {
    this.agents.set(agentId, {
      agentId,
      description,
      resume,
      createdAt: Date.now(),
      isRunning,
    });
    log.info({ agentId, description, isRunning }, 'Subagent registered for continuation');
  }

  /** 查找并返回可继续的子代理 */
  find(agentId: string): ContinuableAgentEntry | undefined {
    const entry = this.agents.get(agentId);
    if (!entry) return undefined;
    // 检查超时
    if (Date.now() - entry.createdAt > DEFAULT_WINDOW_MS) {
      this.agents.delete(agentId);
      log.info({ agentId }, 'Subagent continuation window expired');
      return undefined;
    }
    return entry;
  }

  /** 取消注册（子代理彻底结束后调用） */
  unregister(agentId: string): void {
    this.agents.delete(agentId);
    log.info({ agentId }, 'Subagent unregistered from continuation');
  }

  /** 获取所有活跃的子代理 ID */
  listActive(): string[] {
    return Array.from(this.agents.values())
      .filter((e) => Date.now() - e.createdAt < DEFAULT_WINDOW_MS)
      .map((e) => e.agentId);
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [id, entry] of this.agents) {
      if (now - entry.createdAt > DEFAULT_WINDOW_MS) {
        this.agents.delete(id);
        log.info({ agentId: id }, 'Subagent continuation evicted by cleanup timer');
      }
    }
  }

  /** 关闭清理定时器（测试/清理用） */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}

/** 全局单例 */
export const continuableRegistry = new ContinuableAgentRegistryImpl();
