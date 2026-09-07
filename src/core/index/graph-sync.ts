/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * GraphIndex 同步适配（P3 接线补全）
 *
 * 背景：`GraphIndex.updateFile` 需要 `FileExtractionResult`（AST 提取产物），而
 * `IndexFileWatcher` 只认 `(relPath) => updateFile`。本模块把「读文件 → 提取 →
 * 写图」包装成 watcher 可消费的形状，并补全全量构建入口：
 *
 *   - `GraphFileSync`：增量适配。updateFile(relPath) 内部读文件 + `extractGraphData`
 *     + `GraphIndex.updateFile`，并在每次增量后做一次跨文件解析（幂等，自动补连
 *     其他文件已存在的同名符号）；文件不可读时等价删除。
 *   - `buildGraphIndex`：全量构建。按文件清单逐个提取写入，最后调用一次
 *     `resolveCrossFileCalls` 完成跨文件 callee_id 解析。
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { extractGraphData } from './graph-extractor.js';
import type { GraphIndex } from './graph-index.js';

/** 默认读文件实现（可注入便于单测） */
const defaultRead = (absPath: string): Promise<string> => fs.readFile(absPath, 'utf-8');

/**
 * 增量同步器：与 IndexFileWatcher 的 getIndex 契约对齐
 * （{ size / updateFile(relPath) / removeFile(relPath) }）。
 */
export class GraphFileSync {
  constructor(
    private readonly graph: GraphIndex,
    private readonly workspaceRoot: string,
    private readonly readImpl: (absPath: string) => Promise<string> = defaultRead,
  ) {}

  size(): number {
    return this.graph.size();
  }

  /**
   * 单文件增量更新：读文件 → AST 提取 → 写入图索引。
   * 文件已不可读（删除/移动）→ 等价 removeFile。
   */
  async updateFile(relPath: string): Promise<{ removed: number; added: number }> {
    let content: string;
    try {
      content = await this.readImpl(join(this.workspaceRoot, relPath));
    } catch {
      return this.removeFile(relPath);
    }

    const extracted = await extractGraphData(relPath, content);
    this.graph.updateFile(extracted);
    // 增量后补一次跨文件解析：把本次新增的未解析调用连到已有同名符号。
    // 幂等：只处理 callee_id 为 NULL 的记录，历史残留也会被顺带修复。
    this.graph.resolveCrossFileCalls();
    return { removed: 0, added: extracted.symbols.length };
  }

  /** 删除某文件的所有图数据及外部指向其符号的 callee_id */
  removeFile(relPath: string): { removed: number; added: number } {
    this.graph.removeFileData(relPath);
    return { removed: 0, added: 0 };
  }
}

export interface BuildGraphIndexOptions {
  /** 读文件实现（默认 fs.readFile） */
  readImpl?: (absPath: string) => Promise<string>;
  /** 进度回调（已处理文件数 / 总数），供上层打日志 */
  onProgress?: (done: number, total: number) => void;
}

export interface BuildGraphIndexStats {
  /** 清单内文件总数 */
  filesProcessed: number;
  /** 提取出至少一个符号的文件数 */
  filesWithSymbols: number;
  /** 构建完成后的符号总量 */
  symbols: number;
}

/**
 * 全量构建：按文件清单逐个提取写入图索引，最后做一次跨文件解析。
 * 单个文件失败（读失败/提取异常）只跳过该文件，不阻断整体构建。
 */
export async function buildGraphIndex(
  graph: GraphIndex,
  workspaceRoot: string,
  files: string[],
  opts: BuildGraphIndexOptions = {},
): Promise<BuildGraphIndexStats> {
  const readImpl = opts.readImpl ?? defaultRead;
  let filesWithSymbols = 0;
  for (let i = 0; i < files.length; i++) {
    const rel = files[i];
    try {
      const content = await readImpl(join(workspaceRoot, rel));
      const extracted = await extractGraphData(rel, content);
      graph.updateFile(extracted);
      if (extracted.symbols.length > 0) filesWithSymbols++;
    } catch {
      // 单文件失败跳过（文件可能已在构建间隙被删除），不阻断整体
    }
    opts.onProgress?.(i + 1, files.length);
  }
  graph.resolveCrossFileCalls();
  return { filesProcessed: files.length, filesWithSymbols, symbols: graph.size() };
}