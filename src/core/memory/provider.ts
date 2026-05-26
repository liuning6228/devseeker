/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * IMemoryProvider 接口（Phase 5 Phase A Step 1）
 *
 * Provider 插件体系：内置 .md 文件 Provider + 最多 1 个外部 Provider。
 * 设计参考 Hermes Agent IMemoryProvider。
 *
 * DESIGN-1.md §4.3 · ROADMAP.md 方案三 Phase A Step 1
 */

import type { MemoryRecord, MemoryScope } from './types.js';
import type { MemoryCategory } from './categories.js';
import type { Embedder } from '../index/embedder.js';

/** 写入操作类型 */
export type MemoryWriteAction = 'add' | 'replace' | 'remove';

/** 查询过滤条件 */
export interface MemoryQueryFilter {
  scope?: MemoryScope;
  category?: MemoryCategory;
}

/** Provider 暴露的工具 schema */
export interface ProviderToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** IMemoryProvider —— 记忆存储后端抽象 */
export interface IMemoryProvider {
  readonly name: string;

  /** Provider 是否可用（初始化成功） */
  isAvailable(): boolean;

  /** 初始化（session 启动时调用） */
  initialize(sessionId: string): Promise<void>;

  // ── L0：冻结快照 ──

  /** system prompt 静态指导文本块 */
  systemPromptBlock(): string;

  // ── L1：CRUD 操作（与 MemoryStore 方法签名对齐） ──

  /** 列出记忆 */
  list(filter?: MemoryQueryFilter): Promise<MemoryRecord[]>;

  /** 按 id 查询 */
  getById(id: string): Promise<MemoryRecord | undefined>;

  /** 创建记忆 */
  create(input: {
    title: string;
    content: string;
    category: string;
    keywords: string[];
    scope?: MemoryScope;
  }): Promise<MemoryRecord>;

  /** 更新记忆 */
  update(id: string, patch: {
    title?: string;
    content?: string;
    category?: string;
    keywords?: string[];
  }): Promise<MemoryRecord>;

  /** 删除记忆 */
  remove(id: string): Promise<void>;

  /** 清空（测试用） */
  clear(): Promise<void>;

  // ── L2：后台预取 ──

  /** 预取（跨 turn 预热） */
  prefetch(query: string): Promise<string>;

  // ── 生命周期钩子 ──

  /** 每轮同步 */
  syncTurn(userContent: string, assistantContent: string): Promise<void>;

  /** session 结束 */
  onSessionEnd(messages: unknown[]): Promise<void>;

  /** 写入钩子 */
  onMemoryWrite?(action: string, target: string, content: string): void;

  // ── 工具 ──

  /** 返回该 provider 暴露的工具 schema */
  getToolSchemas(): ProviderToolSchema[];

  /** 处理工具调用 */
  handleToolCall(name: string, args: unknown): Promise<string>;

  /** 关闭 */
  shutdown(): Promise<void>;
}

/** MemoryManager 构造选项 */
export interface MemoryManagerOptions {
  /** 内置 provider（必选） */
  builtin: IMemoryProvider;
  /** 外部 provider（可选，最多 1 个） */
  external?: IMemoryProvider;
  /** 可选 embedder（用于向量计算） */
  embedder?: Embedder;
}

/**
 * MemoryManager —— Provider 编排器。
 * 暴露与 MemoryStore 相同的方法签名，外部调用方只需将 `new MemoryStore()` 替换为 memoryManager。
 */
export class MemoryManager {
  private readonly builtin: IMemoryProvider;
  private readonly external?: IMemoryProvider;
  private _embedder?: Embedder;

  constructor(opts: MemoryManagerOptions) {
    this.builtin = opts.builtin;
    this.external = opts.external;
    this._embedder = opts.embedder;
  }

  get embedder(): Embedder | undefined {
    return this._embedder;
  }

  // ── L0：冻结快照 ──

  /** 构建 system prompt 块 */
  buildSystemPrompt(): string {
    return this.builtin.systemPromptBlock();
  }

  // ── CRUD（全部委托给内置 provider） ──

  async list(filter?: MemoryQueryFilter): Promise<MemoryRecord[]> {
    return this.builtin.list(filter);
  }

  async getById(id: string): Promise<MemoryRecord | undefined> {
    return this.builtin.getById(id);
  }

  async create(input: {
    title: string;
    content: string;
    category: string;
    keywords: string[];
    scope?: MemoryScope;
  }): Promise<MemoryRecord> {
    return this.builtin.create(input);
  }

  async update(id: string, patch: {
    title?: string;
    content?: string;
    category?: string;
    keywords?: string[];
  }): Promise<MemoryRecord> {
    return this.builtin.update(id, patch);
  }

  async remove(id: string): Promise<void> {
    return this.builtin.remove(id);
  }

  async clear(): Promise<void> {
    return this.builtin.clear();
  }

  // ── L2：预取 ──

  async prefetch(query: string): Promise<string> {
    return this.builtin.prefetch(query);
  }

  // ── 生命周期钩子 ──

  async syncTurn(userContent: string, assistantContent: string): Promise<void> {
    await this.builtin.syncTurn(userContent, assistantContent);
  }

  async onSessionEnd(messages: unknown[]): Promise<void> {
    await this.builtin.onSessionEnd(messages);
  }

  // ── 工具 ──

  getToolSchemas(): ProviderToolSchema[] {
    const schemas = [...this.builtin.getToolSchemas()];
    if (this.external) {
      schemas.push(...this.external.getToolSchemas());
    }
    return schemas;
  }

  async handleToolCall(name: string, args: unknown): Promise<string> {
    // 先尝试内置
    const builtinSchemas = this.builtin.getToolSchemas();
    if (builtinSchemas.some((s) => s.name === name)) {
      return this.builtin.handleToolCall(name, args);
    }
    // 再尝试外部
    if (this.external) {
      return this.external.handleToolCall(name, args);
    }
    throw new Error(`未知工具：${name}`);
  }

  async shutdown(): Promise<void> {
    await this.builtin.shutdown();
    await this.external?.shutdown();
  }
}
