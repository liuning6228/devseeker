/**
 * Copyright (c) 2026 DevSeeker Contributors
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
import { isWritableCategory } from './categories.js';
import { getLogger } from '../../infra/logger.js';
import {
  buildSyncTurnExtractionPrompt,
  buildSessionEndExtractionPrompt,
  parseExtractionResult,
  shouldExtractFromTurn,
  summarizeSessionMessages,
  SYNC_TURN_MAX_MEMORIES,
  SESSION_END_MAX_MEMORIES,
} from './extraction-prompt.js';
import type { MemoryExtractorFn } from './extraction-prompt.js';

const log = getLogger('memory.builtin-provider');

/** BuiltinMemoryProvider 扩展选项（P0 自动提炼） */
export interface BuiltinProviderExtractionOptions {
  /** 可选的 LLM 提炼函数。提供后启用自动记忆提炼 */
  extractor?: MemoryExtractorFn;
  /** syncTurn 轻量提炼的 max_tokens（默认 300） */
  syncTurnMaxTokens?: number;
  /** onSessionEnd 批量提炼的 max_tokens（默认 800） */
  sessionEndMaxTokens?: number;
}

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
  /** P0：可选的 LLM 提炼器 */
  private extractor?: MemoryExtractorFn;
  private syncTurnMaxTokens: number;
  private sessionEndMaxTokens: number;
  /** syncTurn 并发锁，避免多轮同时提炼 */
  private syncTurnBusy = false;

  constructor(
    opts: MemoryStoreOptions,
    extractionOpts?: BuiltinProviderExtractionOptions,
  ) {
    this.store = new MemoryStore(opts);
    this.extractor = extractionOpts?.extractor;
    this.syncTurnMaxTokens = extractionOpts?.syncTurnMaxTokens ?? 300;
    this.sessionEndMaxTokens = extractionOpts?.sessionEndMaxTokens ?? 800;
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
   * syncTurn：每轮结束后异步触发（P0 自动提炼）。
   * 从 user/assistant 文本中提取潜在的记忆内容。
   *
   * 流程：
   * 1. 快速预判：文本过短或纯寒暄 → 跳过
   * 2. 构造提炼 prompt → 调用 LLM
   * 3. 解析 JSON 结果 → 写入 MemoryStore
   * 4. 失败静默降级
   */
  async syncTurn(userContent: string, assistantContent: string): Promise<void> {
    // 无提炼器 → 跳过
    if (!this.extractor) return;
    // 并发锁：上一轮提炼未完成 → 跳过本轮
    if (this.syncTurnBusy) {
      log.debug('syncTurn skipped: previous extraction still running');
      return;
    }
    // 快速预判：不值得提炼 → 跳过
    if (!shouldExtractFromTurn(userContent, assistantContent)) return;

    this.syncTurnBusy = true;
    try {
      // 确保 store 已加载（syncTurn 可能是首次操作）
      await this.ensureLoaded();
      const prompt = buildSyncTurnExtractionPrompt(userContent, assistantContent);
      const raw = await this.extractor(prompt, this.syncTurnMaxTokens);
      const extracted = parseExtractionResult(raw);
      if (extracted.length === 0) {
        log.debug('syncTurn: no memories extracted');
        return;
      }

      // 上限裁剪
      const toWrite = extracted.slice(0, SYNC_TURN_MAX_MEMORIES);
      for (const mem of toWrite) {
        try {
          // 安全扫描
          const scanResult = scanMemoryContent(mem.content);
          if (scanResult) {
            log.warn({ title: mem.title, reason: scanResult }, 'syncTurn: memory rejected by security scan');
            continue;
          }
          // 写入（根据类别选择 create 或 createSystem）
          if (isWritableCategory(mem.category)) {
            await this.store.create({
              title: mem.title,
              content: mem.content,
              category: mem.category,
              keywords: mem.keywords,
            });
          } else {
            await this.store.createSystem({
              title: mem.title,
              content: mem.content,
              category: mem.category,
              keywords: mem.keywords,
            });
          }
          // 触发写入钩子
          this.onMemoryWriteCb?.('add', 'memory', mem.content);
          log.info({ title: mem.title, category: mem.category }, 'syncTurn: memory extracted');
        } catch (e) {
          log.warn({ err: String(e), title: mem.title }, 'syncTurn: failed to write memory');
        }
      }
    } catch (e) {
      // 提炼失败静默降级
      log.warn({ err: String(e) }, 'syncTurn: extraction failed, skipping');
    } finally {
      this.syncTurnBusy = false;
    }
  }

  /**
   * onSessionEnd：session 结束时批量提取记忆（P0 自动提炼）。
   * 从完整 messages 中提取任务总结、踩坑经验、参考文件。
   */
  async onSessionEnd(messages: unknown[]): Promise<void> {
    if (!this.extractor) return;
    if (!messages || messages.length === 0) {
      log.info('onSessionEnd: no messages to extract from');
      return;
    }

    try {
      // 确保 store 已加载
      await this.ensureLoaded();
      // 类型安全的 messages 处理
      const typedMessages = messages as Array<{
        role: string;
        content?: string;
        tool_calls?: unknown[];
        name?: string;
      }>;

      const { taskGoal, keyActions, finalOutcome } = summarizeSessionMessages(typedMessages);
      if (!taskGoal && keyActions.length === 0) {
        log.info('onSessionEnd: no meaningful content to extract');
        return;
      }

      const prompt = buildSessionEndExtractionPrompt(taskGoal, keyActions, finalOutcome);
      const raw = await this.extractor(prompt, this.sessionEndMaxTokens);
      const extracted = parseExtractionResult(raw);
      if (extracted.length === 0) {
        log.info('onSessionEnd: no memories extracted');
        return;
      }

      // 上限裁剪
      const toWrite = extracted.slice(0, SESSION_END_MAX_MEMORIES);
      let writtenCount = 0;
      for (const mem of toWrite) {
        try {
          const scanResult = scanMemoryContent(mem.content);
          if (scanResult) {
            log.warn({ title: mem.title, reason: scanResult }, 'onSessionEnd: memory rejected by security scan');
            continue;
          }
          if (isWritableCategory(mem.category)) {
            await this.store.create({
              title: mem.title,
              content: mem.content,
              category: mem.category,
              keywords: mem.keywords,
            });
          } else {
            await this.store.createSystem({
              title: mem.title,
              content: mem.content,
              category: mem.category,
              keywords: mem.keywords,
            });
          }
          this.onMemoryWriteCb?.('add', 'memory', mem.content);
          writtenCount++;
          log.info({ title: mem.title, category: mem.category }, 'onSessionEnd: memory extracted');
        } catch (e) {
          log.warn({ err: String(e), title: mem.title }, 'onSessionEnd: failed to write memory');
        }
      }
      log.info({ total: extracted.length, written: writtenCount }, 'onSessionEnd: extraction completed');
    } catch (e) {
      log.warn({ err: String(e) }, 'onSessionEnd: extraction failed');
    }
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
