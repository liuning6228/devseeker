/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W13.4-C-1 · BM25 Codebase Index
 *
 * 零模型保底路径（lexical）。生命周期与 public 方法**完全镜像** `CodebaseIndex`，
 * 但内部用 `Bm25Index` 替代向量存储，`reindex` 跳过 embedding 阶段。
 *
 * 适用场景：
 *   - 首次激活扩展时离线 BERT 模型尚未下载完成，BM25 可即时提供基础检索
 *   - 小型仓库（< 500 文件）下 BM25 冷启动 < 500ms，好于 e5-small 的 5-10s
 *   - 用户显式 `embedProvider = 'bm25'`（隐私 / 低配置机器 / CI 环境）
 *   - 后续 W13.4-C-3（如需）作为 hybrid search 的 lexical 分量
 *
 * 设计要点：
 *   - implements `IndexReader` · 对 `search_codebase` 工具完全透明
 *   - 不需要 embedder 参数 · `CodebaseIndexOptions` 裁剪为 `Bm25CodebaseIndexOptions`
 *   - 持久化走 `Bm25Index.saveToFile / loadFromFile`（快照格式含 `flavor: 'bm25'`）
 *   - `search` 直接调 `bm25.search`，**不做 rerank**（BM25 已是 lexical，rerank 冗余）
 *   - 空库 `search` 抛 `AgentError(INDEX_NOT_READY)`，与 `CodebaseIndex` 行为一致
 */

import { promises as fs } from 'node:fs';
import { join as joinPath } from 'node:path';
import {
  scanWorkspace,
  type ScannerOptions,
  type ScannedFile,
  type FilterSample,
} from './scanner.js';
import { chunkText, type ChunkOptions, type TextChunk } from './chunker.js';
import { astChunkText } from './ast-chunker.js';
import { Bm25Index, type Bm25Record } from './bm25-index.js';
import type { IndexProgress, CodebaseIndexLike, SearchResult, ReindexStats } from './codebase-index.js';
import { AgentError, ErrorCodes } from '../errors/index.js';

export interface Bm25CodebaseIndexOptions {
  workspaceRoot: string;
  /** BM25 快照落盘路径。建议与向量库区分：`.dualmind/bm25-index.json`。 */
  storePath: string;
  scanner?: ScannerOptions;
  chunker?: ChunkOptions;
  onProgress?: (p: IndexProgress) => void;
  readFileImpl?: (absPath: string) => Promise<string>;
  signal?: AbortSignal;
  /** BM25 参数（默认 k1=1.5 / b=0.75）。 */
  bm25Params?: { k1?: number; b?: number };
}

export class Bm25CodebaseIndex implements CodebaseIndexLike {
  private bm25: Bm25Index;
  private readonly opts: Bm25CodebaseIndexOptions;

  private constructor(opts: Bm25CodebaseIndexOptions, bm25: Bm25Index) {
    this.opts = opts;
    this.bm25 = bm25;
  }

  /**
   * 工厂：优先从 storePath 加载持久化快照；否则返回空库。
   * 若快照 flavor 不是 `'bm25'` 或 version 不兼容，`Bm25Index.loadFromFile`
   * 会抛 `AgentError(INDEX_DB_CORRUPTED)`，这里接住并返回空库（调用方可触发 reindex）。
   */
  static async create(opts: Bm25CodebaseIndexOptions): Promise<Bm25CodebaseIndex> {
    let loaded: Bm25Index | undefined;
    try {
      loaded = await Bm25Index.loadFromFile(opts.storePath);
    } catch {
      loaded = undefined; // 损坏的快照视作"无"，调用方可触发 reindex
    }
    const bm25 = loaded ?? new Bm25Index(opts.bm25Params ?? {});
    return new Bm25CodebaseIndex(opts, bm25);
  }

  size(): number {
    return this.bm25.size();
  }

  listIndexedFiles(): string[] {
    return this.bm25.listIndexedFiles();
  }

  /**
   * 全量重建索引。
   * 复用 `scanWorkspace` + `chunkText`，但跳过 embedding 阶段，chunks 直接
   * 转 `Bm25Record` 后 `upsert`。进度事件的 `phase: 'embedding'` 仍然发射，
   * 保持上游 UI（状态栏、黄条）代码零修改；语义上理解为"索引中"。
   */
  async reindex(): Promise<ReindexStats> {
    const started = Date.now();
    const readFileImpl = this.opts.readFileImpl ?? ((p) => fs.readFile(p, 'utf-8'));

    this.emit({
      phase: 'scanning',
      filesTotal: 0,
      filesDone: 0,
      chunksTotal: 0,
      chunksDone: 0,
    });

    const scan = await scanWorkspace(this.opts.workspaceRoot, this.opts.scanner);
    this.assertNotAborted();

    this.emit({
      phase: 'chunking',
      filesTotal: scan.files.length,
      filesDone: 0,
      chunksTotal: 0,
      chunksDone: 0,
    });

    const fileChunks: Array<{ file: ScannedFile; chunks: TextChunk[] }> = [];
    for (let i = 0; i < scan.files.length; i++) {
      const f = scan.files[i];
      this.assertNotAborted();
      let content: string;
      try {
        content = await readFileImpl(f.absPath);
      } catch {
        continue;
      }
      const chunks = await astChunkText(f.relPath, content, this.opts.chunker);
      fileChunks.push({ file: f, chunks });
      if ((i + 1) % 20 === 0 || i === scan.files.length - 1) {
        this.emit({
          phase: 'chunking',
          filesTotal: scan.files.length,
          filesDone: i + 1,
          chunksTotal: fileChunks.reduce((sum, x) => sum + x.chunks.length, 0),
          chunksDone: 0,
        });
      }
    }

    const flatChunks: TextChunk[] = fileChunks.flatMap((f) => f.chunks);

    // "embedding" 阶段：对 BM25 来说就是 upsert；保留 phase 名以让上游 UI 零修改
    this.emit({
      phase: 'embedding',
      filesTotal: scan.files.length,
      filesDone: scan.files.length,
      chunksTotal: flatChunks.length,
      chunksDone: 0,
    });

    // 先清空旧数据
    this.bm25.clear();

    // BM25 无需批量 API 调用，一次性 upsert 即可；但分批发射进度事件保持体感一致
    const BATCH = 200;
    let chunksDone = 0;
    for (let i = 0; i < flatChunks.length; i += BATCH) {
      this.assertNotAborted();
      const batch = flatChunks.slice(i, i + BATCH).filter((c) => c.text.trim().length > 0);
      if (batch.length > 0) {
        const records: Bm25Record[] = batch.map((c) => ({
          id: `${c.filePath}#${c.startLine}-${c.endLine}`,
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
        }));
        this.bm25.upsert(records);
      }
      chunksDone += flatChunks.slice(i, i + BATCH).length;
      this.emit({
        phase: 'embedding',
        filesTotal: scan.files.length,
        filesDone: scan.files.length,
        chunksTotal: flatChunks.length,
        chunksDone,
      });
    }

    // 持久化
    this.emit({
      phase: 'saving',
      filesTotal: scan.files.length,
      filesDone: scan.files.length,
      chunksTotal: flatChunks.length,
      chunksDone,
    });
    try {
      await this.bm25.saveToFile(this.opts.storePath);
    } catch (e) {
      throw new AgentError({
        code: ErrorCodes.INDEX_DB_WRITE_FAIL,
        message: `BM25 索引持久化失败: ${(e as Error).message}`,
      });
    }

    const stats: ReindexStats = {
      filesScanned: scan.files.length,
      filesSkippedLarge: scan.skippedLarge,
      filesSkippedExt: scan.skippedExt,
      chunksEmbedded: flatChunks.length, // 语义上"入库 chunks 数"，与 CodebaseIndex 对齐
      tokensUsed: 0, // BM25 零模型，无 tokens 概念
      durationMs: Date.now() - started,
      filterSamples: scan.filterSamples as FilterSample[],
    };

    this.emit({
      phase: 'done',
      filesTotal: scan.files.length,
      filesDone: scan.files.length,
      chunksTotal: flatChunks.length,
      chunksDone,
      message: `BM25 索引完成：${flatChunks.length} chunks / ${scan.files.length} files`,
    });

    return stats;
  }

  /**
   * BM25 lexical 检索。与 `CodebaseIndex.search` 签名对齐，但 `rerank` 参数被忽略
   * （BM25 本身就是 lexical 打分，再跑 keyword rerank 会导致分数合并扭曲）。
   */
  async search(
    query: string,
    topK = 10,
    _opts: { rerank?: boolean } = {},
  ): Promise<SearchResult[]> {
    if (this.bm25.size() === 0) {
      throw new AgentError({
        code: ErrorCodes.INDEX_NOT_READY,
        message: '代码库尚未建立索引，请先运行 DualMind: Reindex Codebase',
      });
    }
    const trimmed = query.trim();
    if (!trimmed) return [];

    const hits = this.bm25.search(trimmed, topK);
    return hits.map((h) => ({
      filePath: h.record.filePath,
      startLine: h.record.startLine,
      endLine: h.record.endLine,
      text: h.record.text,
      score: h.score,
    }));
  }

  /** 立即落盘当前索引。 */
  async save(): Promise<void> {
    await this.bm25.saveToFile(this.opts.storePath);
  }

  /**
   * 增量更新：单文件变更后重新 upsert 该文件 chunks。
   */
  async updateFile(relPath: string): Promise<{ removed: number; added: number }> {
    const readFileImpl = this.opts.readFileImpl ?? ((p) => fs.readFile(p, 'utf-8'));
    const absPath = joinPath(this.opts.workspaceRoot, relPath);

    let content: string;
    try {
      content = await readFileImpl(absPath);
    } catch {
      return this.removeFile(relPath);
    }

    const removed = this.bm25.deleteByFile(relPath);
    const chunks = await astChunkText(relPath, content, this.opts.chunker);
    if (chunks.length > 0) {
      const records: Bm25Record[] = chunks
        .filter((c) => c.text.trim().length > 0)
        .map((c) => ({
          id: `${c.filePath}#${c.startLine}-${c.endLine}`,
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
        }));
      if (records.length > 0) {
        this.bm25.upsert(records);
      }
    }
    await this.save();
    return { removed, added: chunks.length };
  }

  /** 删除某文件的所有 chunks 并立即落盘。 */
  removeFile(relPath: string): { removed: number; added: number } {
    const removed = this.bm25.deleteByFile(relPath);
    if (removed > 0) {
      void this.save().catch(() => {
        /* swallow */
      });
    }
    return { removed, added: 0 };
  }

  private emit(p: IndexProgress): void {
    try {
      this.opts.onProgress?.(p);
    } catch {
      /* ignore */
    }
  }

  private assertNotAborted(): void {
    if (this.opts.signal?.aborted) {
      throw new AgentError({
        code: ErrorCodes.TASK_LOOP_ABORTED,
        message: 'BM25 索引被中止',
      });
    }
  }
}

/**
 * BM25 索引默认落盘路径：`.dualmind/bm25-index.json`（与 `codebase-index.json` 并列）。
 * 与向量库分家，避免 provider 切换时互相覆盖。
 */
export function defaultBm25IndexStorePath(workspaceRoot: string): string {
  return joinPath(workspaceRoot, '.dualmind', 'bm25-index.json');
}
