/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * AssetIndexer 类型定义（C1 文档画像引擎）
 *
 * AssetMeta 用于内部"提取→描述"管道。
 * search() 输出统一为 SearchResult（与 CodebaseIndex 共享契约，修复适配问题 P3）。
 */

export type AssetType = 'pdf' | 'image' | 'svg';

export interface AssetMeta {
  /** 工作区相对路径，POSIX 分隔符 */
  relPath: string;
  type: AssetType;
  /** 提取的描述性文本（供检索） */
  description: string;
  /** 结构化元数据 */
  structured: Record<string, unknown>;
  /** 文件级标签 */
  tags: string[];
  /** 字节大小 */
  byteSize: number;
  /** 最后修改时间（ms） */
  mtimeMs: number;
}

/** 与 CodebaseIndex.search 返回类型一致（IndexReader 契约） */
export interface SearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
}

/** AssetIndexer 实现 IndexReader 读端契约（与 codebase-index 共享） */
export interface IndexReader {
  size(): number;
  listIndexedFiles(): string[];
  search(query: string, topK?: number): Promise<SearchResult[]>;
}
