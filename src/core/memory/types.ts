/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Memory 类型
 */

import type { MemoryCategory } from './categories.js';

/** 记忆作用域 */
export type MemoryScope = 'workspace' | 'global';

/** 一条记忆记录 */
export interface MemoryRecord {
  /** 唯一 id：`mem_<timestamp>_<rand>` */
  id: string;
  /** 简短标题（用于 overview） */
  title: string;
  /** 详细内容 */
  content: string;
  /** 分类（WritableCategory 或 SystemCategory） */
  category: MemoryCategory;
  /** 关键词（检索 trigger） */
  keywords: string[];
  /** 作用域 */
  scope: MemoryScope;
  /** 创建时间（ms） */
  createdAt: number;
  /** 最后更新时间（ms） */
  updatedAt: number;
  /**
   * 预计算的 embedding 向量（v1.8.0 新增）。
   * 由 store.create()/update() 在写入时自动计算，用于向量语义检索。
   * 可选——旧 JSONL 中无此字段时退化到纯关键词匹配。
   */
  _embedding?: number[];
}

/** update_memory 支持的动作 */
export type MemoryAction = 'create' | 'update' | 'delete';

/** search_memory 支持的深度 */
export type SearchDepth = 'fetch' | 'shallow' | 'deep' | 'explore';

/** 搜索命中项（含评分） */
export interface MemoryHit {
  record: MemoryRecord;
  /** 0~1 之间的相关度评分 */
  score: number;
  /** 命中来源：用哪些字段命中的 */
  matchedOn: Array<'title' | 'content' | 'keywords' | 'category' | 'vector'>;
}
