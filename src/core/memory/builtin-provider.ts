/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * BuiltinMemoryProvider（Phase 5 Phase A Step 2 / Phase D M1+M3）
 *
 * 包装现有 MemoryStore 实例作为内置 Provider。
 * 所有现有功能（JSONL、28 类、_embedding、keywords 增强、search 4 档 depth）原封不动。
 *
 * Phase D 扩展：
 * - M1：生命周期钩子（syncTurn / onSessionEnd / onMemoryWrite）
 * - M3：写前安全扫描（scanMemoryContent）集成到 create/update
 *
 * DESIGN-1.md §4.3 · ROADMAP.md 方案三 Phase A Step 2 / Phase D M1+M3
 */

import type { IMemoryProvider, ProviderToolSchema, MemoryQueryFilter, MemoryWriteAction } from './provider.js';
import type { MemoryRecord, MemoryScope } from './types.js';
import { MemoryStore } from './store.js';
import type { MemoryStoreOptions } from './store.js';
import { scanMemoryContent } from './scan.js';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('memory.builtin-provider');

/**
 * BuiltinMemoryProvider —— 基于 MemoryStore 的内置 Provider。
 * 包装 + 安全扫描 + 生命周期钩子。
 */
export class BuiltinMemoryProvider implements IMemoryProvider {
  readonly name = 'builtin';
  private store: MemoryStore;
  private initialized = false;
  /** 记忆写入钩子回调 */
  private onMemoryWriteCb?: (action: string, target: string, content: string) => void;

  constructor(opts: MemoryStoreOptions) {
    this.store = new MemoryStore(opts);
  }

  isAvailable(): boolean {
    return this.initialized;
  }

  async initialize(_sessionId: string): Promise<void> {
    if (!this.initialized) {
      await this.store.load();
      this.initialized = true;
    }
  }

  systemPromptBlock(): string {
    return '';
  }

  // ── CRUD 委托 ──

  async list(filter?: MemoryQueryFilter): Promise<MemoryRecord[]> {
    await this.ensureLoaded();
    return this.store.list(filter as Parameters<MemoryStore['list']>[0]);
  }

  async getById(id: string): Promise<MemoryRecord | undefined> {
    await this.ensureLoaded();
    return this.store.getById(id);
  }

  async create(input: {
    title: string;
    content: string;
    category: string;
    keywords: string[];
    scope?: MemoryScope;
  }): Promise<MemoryRecord> {
    await this.ensureLoaded();
    // M3：写前安全扫描
    const scanResult = scanMemoryContent(input.content);
    if (scanResult) {
      throw new Error(`记忆写入被安全扫描拒绝: ${scanResult}`);
    }
    const record = await this.store.create(input);
    // M1：触发写入钩子
    this.onMemoryWriteCb?.('add', 'memory', input.content);
    return record;
  }

  async update(id: string, patch: {
    title?: string;
    content?: string;
    category?: string;
    keywords?: string[];
  }): Promise<MemoryRecord> {
    await this.ensureLoaded();
    // M3：写前安全扫描
    if (patch.content) {
      const scanResult = scanMemoryContent(patch.content);
      if (scanResult) {
        throw new Error(`记忆更新被安全扫描拒绝: ${scanResult}`);
      }
    }
    const record = await this.store.update(id, patch);
    // M1：触发写入钩子
    if (patch.content) {
      this.onMemoryWriteCb?.('replace', 'memory', patch.content);
    }
    return record;
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded();
    return this.store.remove(id);
  }

  async clear(): Promise<void> {
    await this.ensureLoaded();
    return this.store.clear();
  }

  // ── L2 预取 ──

  async prefetch(_query: string): Promise<string> {
    return '';
  }

  // ── M1：生命周期钩子 ──

  /**
   * syncTurn：每轮结束后异步触发。
   * 从 user/assistant 文本中提取潜在的记忆内容。
   * 当前实现为占位——实际提取逻辑在 Phase C 中扩展。
   */
  async syncTurn(_userContent: string, _assistantContent: string): Promise<void> {
    // TODO: Phase C 实现自动记忆提取
  }

  /**
   * onSessionEnd：session 结束时批量提取记忆。
   * 当前为占位——实际实现为遍历 messages 提取关键信息。
   */
  async onSessionEnd(_messages: unknown[]): Promise<void> {
    // TODO: Phase C 实现批量记忆提取
    log.info('onSessionEnd called, memory extraction not yet implemented');
  }

  /**
   * 注册内存写入钩子（由 MemoryManager 或 panel 设置）。
   * 每次 add/replace 成功后触发。
   */
  onMemoryWrite(action: string, target: string, content: string): void {
    this.onMemoryWriteCb?.(action, target, content);
  }

  // ── 工具 ──

  getToolSchemas(): ProviderToolSchema[] {
    return [];
  }

  async handleToolCall(_name: string, _args: unknown): Promise<string> {
    throw new Error('BuiltinMemoryProvider: 未注册工具');
  }

  async shutdown(): Promise<void> {
    // 无需特殊清理
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.initialized) {
      await this.store.load();
      this.initialized = true;
    }
  }
}
