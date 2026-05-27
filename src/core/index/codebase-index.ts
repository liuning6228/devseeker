/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CodebaseIndex —— 代码库语义索引协调器（W3 批次 1）
 *
 * 职责：
 * - 串联 scanner → chunker → embedder → vector-store
 * - 提供 reindex / search / onDidChangeFile / load / save 接口
 * - 进度回调（files done / total）
 *
 * 边界：
 * - 不依赖 vscode API（便于测试）
 * - 切分使用 M4-tree-sitter AST 感知分块器（astChunkText），
 *   对 TS/JS/Py/Java/Go/Rust 做语法感知切分，其余语言回退到行滑窗
 */

import { promises as fs } from 'node:fs';
import { join as joinPath } from 'node:path';
import { scanWorkspace, type ScannerOptions, type ScannedFile, type FilterSample } from './scanner.js';
import { chunkText, type ChunkOptions, type TextChunk } from './chunker.js';
import { astChunkText } from './ast-chunker.js';
import type { Embedder } from './embedder.js';
import { SqliteVectorStore } from './sqlite-vector-store.js';
import type { VectorRecord, SearchHit } from './vector-store.js';
import { keywordRerank } from './reranker.js';
import type { Rankable } from './reranker.js';
import { AgentError, ErrorCodes } from '../errors/index.js';
import { openSqliteDatabase, defaultIndexSqlitePath } from '../storage/sqlite-db.js';

export interface IndexProgress {
  phase: 'scanning' | 'chunking' | 'embedding' | 'saving' | 'done';
  filesTotal: number;
  filesDone: number;
  chunksTotal: number;
  chunksDone: number;
  message?: string;
}

export interface CodebaseIndexOptions {
  workspaceRoot: string;
  embedder: Embedder;
  /** 旧 JSON 索引文件路径（用于自动迁移）；迁移完成后不再需要 */
  storePath: string;
  scanner?: ScannerOptions;
  chunker?: ChunkOptions;
  /** 进度回调 */
  onProgress?: (p: IndexProgress) => void;
  /** 注入自定义 readFile（便于测试） */
  readFileImpl?: (absPath: string) => Promise<string>;
  /** AbortSignal 以便取消 */
  signal?: AbortSignal;
}

export interface SearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
}

/**
 * W13.4-C-1 · 索引读端通用契约。
 *
 * 对 `search_codebase` 工具、后续 hybrid search / status 展示等上层抽象
 * 掩盖底层实现（向量 vs BM25）。同时：
 *   - `CodebaseIndex`（向量检索，e5-small / bge-m3-zh / DashScope）implements
 *   - `Bm25CodebaseIndex`（零模型 lexical 保底）implements
 *
 * 只暴露读端必需的三个方法；写端（reindex / updateFile / removeFile / save）
 * 见 `CodebaseIndexLike`（W13.4-C-2 新增）。
 */
export interface IndexReader {
  /** 当前索引的 chunk 数（> 0 表示索引就绪）。 */
  size(): number;
  /** 索引覆盖的文件相对路径列表（用于 UI 展示 / auto-indexer 跳过判定）。 */
  listIndexedFiles(): string[];
  /** 检索：空库必须抛 `AgentError(INDEX_NOT_READY)`。 */
  search(query: string, topK?: number, opts?: { rerank?: boolean }): Promise<SearchResult[]>;
}

/**
 * W13.4-C-2 · 可 reindex 的完整索引契约（继承读端）。
 *
 * `CodebaseIndex`（向量）和 `Bm25CodebaseIndex`（lexical）都 implements 它。
 * panel.ts 的 `codebaseIndex` 字段、`auto-indexer.runAutoReindex` 创建返回值
 * 都用本接口；上层代码对底层 provider **完全透明**。
 */
export interface CodebaseIndexLike extends IndexReader {
  reindex(): Promise<ReindexStats>;
  save(): Promise<void>;
  updateFile(relPath: string): Promise<{ removed: number; added: number }>;
  removeFile(relPath: string): { removed: number; added: number };
}

export interface ReindexStats {
  filesScanned: number;
  filesSkippedLarge: number;
  filesSkippedExt: number;
  chunksEmbedded: number;
  tokensUsed: number;
  durationMs: number;
  /** B-1.0.1-C · 被过滤样本（供上层在 0 files 时打诊断日志） */
  filterSamples: FilterSample[];
}

export class CodebaseIndex implements CodebaseIndexLike {
  private store: SqliteVectorStore;
  private readonly opts: CodebaseIndexOptions;
  /** 索引专用库连接（与 sessions/usage 分库），在 create() 中打开，dispose 时关闭 */
  private indexDb: import('../storage/sqlite-db.js').SqliteDatabaseLike | undefined;

  private constructor(opts: CodebaseIndexOptions, store: SqliteVectorStore, indexDb?: import('../storage/sqlite-db.js').SqliteDatabaseLike) {
    this.opts = opts;
    this.store = store;
    this.indexDb = indexDb;
  }

  /** 关闭索引专用的 SQLite 连接，释放底层文件锁（Windows 上删除前必须先调用）。 */
  dispose(): void {
    if (this.indexDb) {
      this.indexDb.close();
      this.indexDb = undefined;
    }
  }

  /**
   * 工厂：打开索引专用 SQLite 库，从其中加载向量索引。
   * 若索引库中无数据则尝试从旧 JSON 迁移。
   * 若持久化 modelId 与 embedder.modelId 不匹配，需 reindex。
   */
  static async create(opts: CodebaseIndexOptions): Promise<CodebaseIndex> {
    const indexDb = await openSqliteDatabase({ dbPath: defaultIndexSqlitePath(opts.workspaceRoot) });
    const store = await SqliteVectorStore.create({
      db: indexDb,
      dimension: opts.embedder.dimension,
      modelId: opts.embedder.modelId,
      legacyJsonPath: opts.storePath,
    });
    return new CodebaseIndex(opts, store, indexDb);
  }

  size(): number {
    return this.store.size();
  }

  listIndexedFiles(): string[] {
    return this.store.listIndexedFiles();
  }

  /**
   * 全量重建索引。
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

    // 分块
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

    // Embedding
    this.emit({
      phase: 'embedding',
      filesTotal: scan.files.length,
      filesDone: scan.files.length,
      chunksTotal: flatChunks.length,
      chunksDone: 0,
    });

    // 先清空旧数据，保证干净
    this.store.clear();

    let chunksDone = 0;
    let tokensUsed = 0;
    const BATCH = 25;
    for (let i = 0; i < flatChunks.length; i += BATCH) {
      this.assertNotAborted();
      const batch = flatChunks.slice(i, i + BATCH);
      // 过滤空片段（DashScope 要求 input length ∈ [1, 8192] tokens，0 长度也会 400）
      const prepared = batch
        .map((c) => ({ chunk: c, input: truncateForEmbedding(c.text) }))
        .filter((p) => p.input.length > 0);
      if (prepared.length === 0) {
        chunksDone += batch.length;
        continue;
      }
      const inputs = prepared.map((p) => p.input);
      const { vectors, totalTokens } = await this.opts.embedder.embed(inputs);
      if (totalTokens) tokensUsed += totalTokens;

      const recs: VectorRecord[] = prepared.map((p, k) => ({
        id: `${p.chunk.filePath}#${p.chunk.startLine}-${p.chunk.endLine}`,
        filePath: p.chunk.filePath,
        startLine: p.chunk.startLine,
        endLine: p.chunk.endLine,
        vector: vectors[k],
      }));
      this.store.upsert(recs);
      chunksDone += batch.length;
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
    // W3b3 · SQLite 自动持久化（WAL 模式），无需手动 save
    await this.store.save();

    const stats: ReindexStats = {
      filesScanned: scan.files.length,
      filesSkippedLarge: scan.skippedLarge,
      filesSkippedExt: scan.skippedExt,
      chunksEmbedded: flatChunks.length,
      tokensUsed,
      durationMs: Date.now() - started,
      filterSamples: scan.filterSamples,
    };

    this.emit({
      phase: 'done',
      filesTotal: scan.files.length,
      filesDone: scan.files.length,
      chunksTotal: flatChunks.length,
      chunksDone,
      message: `索引完成：${flatChunks.length} chunks / ${scan.files.length} files`,
    });

    return stats;
  }

  /**
   * 语义搜索。
   *
   * W11.7 · 返回前默认过一遍关键词/路径 rerank，拼高能被查询关键词
   * 直接命中的候选，缓解纯向量命中的假阳性。可通过 `rerank=false` 关闭。
   */
  async search(
    query: string,
    topK = 10,
    opts: { rerank?: boolean } = {},
  ): Promise<SearchResult[]> {
    if (this.store.size() === 0) {
      throw new AgentError({
        code: ErrorCodes.INDEX_NOT_READY,
        message: '代码库尚未建立索引，请先运行 DevSeeker: Reindex Codebase',
      });
    }
    const trimmed = query.trim();
    if (!trimmed) return [];

    const qInput = truncateForEmbedding(trimmed);
    if (!qInput) return [];
    // v1.2.0 W13.4：e5 系列模型需要对 query 加 `query: ` 前缀；其他实现（如 DashScope）忽略。
    const { vectors } = await this.opts.embedder.embed([qInput], { kind: 'query' });
    const qv = vectors[0];
    // 先取 topK*2 送入 rerank，给重排留批注空间
    const recallK = (opts.rerank ?? true) ? Math.max(topK * 2, topK) : topK;
    const hits: SearchHit[] = this.store.search(qv, recallK);
    const base: SearchResult[] = hits.map((h) => ({
      filePath: h.record.filePath,
      startLine: h.record.startLine,
      endLine: h.record.endLine,
      text: h.record.text ?? '',
      score: h.score,
    }));
    if (opts.rerank === false) return base.slice(0, topK);
    return keywordRerank(trimmed, base as Rankable[], { topK }) as SearchResult[];
  }

  /** SQLite 自动持久化，此方法保留为 no-op 以兼容 CodebaseIndexLike 接口 */
  async save(): Promise<void> {
    await this.store.save();
  }

  /**
   * 增量更新：单文件变更后重新索引该文件。
   * - 先删除该文件旧 chunks
   * - 重新读取、切分、嵌入、存储
   * - 最后落盘
   */
  async updateFile(relPath: string): Promise<{ removed: number; added: number }> {
    const readFileImpl = this.opts.readFileImpl ?? ((p) => fs.readFile(p, 'utf-8'));
    const absPath = joinPath(this.opts.workspaceRoot, relPath);

    let content: string;
    try {
      content = await readFileImpl(absPath);
    } catch {
      // 文件已不可读 → 当作删除处理
      return this.removeFile(relPath);
    }

    const removed = this.store.deleteByFile(relPath);
    const chunks = await astChunkText(relPath, content, this.opts.chunker);
    if (chunks.length > 0) {
      // 同批量构建逻辑：过滤空片段，避免 400
      const prepared = chunks
        .map((c) => ({ chunk: c, input: truncateForEmbedding(c.text) }))
        .filter((p) => p.input.length > 0);
      if (prepared.length > 0) {
        const inputs = prepared.map((p) => p.input);
        const { vectors } = await this.opts.embedder.embed(inputs);
        const recs: VectorRecord[] = prepared.map((p, k) => ({
          id: `${p.chunk.filePath}#${p.chunk.startLine}-${p.chunk.endLine}`,
          filePath: p.chunk.filePath,
          startLine: p.chunk.startLine,
          endLine: p.chunk.endLine,
          text: p.chunk.text,
          vector: vectors[k],
        }));
        this.store.upsert(recs);
      }
    }
    await this.save();
    return { removed, added: chunks.length };
  }

  /**
   * 删除某文件的所有 chunks 并立即落盘。
   */
  removeFile(relPath: string): { removed: number; added: number } {
    const removed = this.store.deleteByFile(relPath);
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
        message: '索引任务已取消',
      });
    }
  }
}

// ─────────── helpers ───────────

/**
 * DashScope text-embedding-v3：服务端要求 input length ∈ [1, 8192] tokens。
 * 经验值：
 *   - 纯英文 1 token ≈ 4 chars
 *   - 中英混合 / 中文密集 1 token ≈ 1.5–2 chars（最差情况）
 * 按最差情况反算：8192 tokens × 1.5 chars/token ≈ 12300 chars。
 * 为保留 10% 安全系数，取 8000 chars（约 4000–5500 tokens）。
 */
const MAX_EMBED_INPUT_CHARS = 8_000;

function truncateForEmbedding(s: string): string {
  // 去除前后空白；trim 后为空则返回空串，调用方用 length > 0 过滤
  const t = s.trim();
  if (!t) return '';
  if (t.length <= MAX_EMBED_INPUT_CHARS) return t;
  return t.slice(0, MAX_EMBED_INPUT_CHARS);
}

/** 导出默认索引文件相对路径（供 panel / extension 使用） */
export function defaultIndexStorePath(workspaceRoot: string): string {
  return joinPath(workspaceRoot, '.devseeker', 'codebase-index.json');
}

// ─────────── §8.15.2 · 编辑后符号引用验证 ───────────

export interface ReferenceIssue {
  /** 引用符号名 */
  symbolName: string;
  /** 引用所在的源文件 */
  sourceFile: string;
  /** 引用所在的代码行（1-based） */
  lineNumber: number;
  /** 引用类型 */
  referenceType: 'import' | 'require' | 'dynamic-import';
  /** 建议的修复候选 */
  candidates?: string[];
}

/**
 * 从文件内容中提取所有 import/require 的符号引用。
 * 使用正则提取（轻量，不依赖 tree-sitter）。
 */
function extractImportReferences(content: string): Array<{
  symbolName: string;
  lineNumber: number;
  type: 'import' | 'require' | 'dynamic-import';
  modulePath: string;
}> {
  const results: Array<{ symbolName: string; lineNumber: number; type: 'import' | 'require' | 'dynamic-import'; modulePath: string }> = [];

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // 匹配 import { X, Y } from 'path'
    const importMatch = line.match(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      const symbols = importMatch[1]!.split(',').map(s => s.trim()).filter(Boolean);
      for (const sym of symbols) {
        // 去掉 as 别名：'X as Y' → 'X'
        const name = sym.split(/\s+as\s+/)[0]!.trim();
        results.push({ symbolName: name, lineNumber: i + 1, type: 'import', modulePath: importMatch[2]! });
      }
    }

    // 匹配 import X from 'path'（default import）
    const defaultImport = line.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (defaultImport && !line.includes('{')) {
      results.push({ symbolName: defaultImport[1]!, lineNumber: i + 1, type: 'import', modulePath: defaultImport[2]! });
    }

    // 匹配 require('path')
    const requireMatch = line.match(/require\(['"]([^'"]+)['"]\)/);
    if (requireMatch) {
      const varName = line.match(/(\w+)\s*=\s*require/);
      if (varName) {
        results.push({ symbolName: varName[1]!, lineNumber: i + 1, type: 'require', modulePath: requireMatch[1]! });
      }
    }

    // 匹配 import('path')
    const dynImport = line.match(/import\(['"]([^'"]+)['"]\)/);
    if (dynImport && line.includes('import(')) {
      const varName = line.match(/(\w+)\s*=\s*import\(/);
      if (varName) {
        results.push({ symbolName: varName[1]!, lineNumber: i + 1, type: 'dynamic-import', modulePath: dynImport[1]! });
      }
    }
  }

  return results;
}

/**
 * 从索引中搜索同名导出，返回候选文件路径列表。
 */
async function searchExportInIndex(
  symbolName: string,
  excludeFile: string,
  indexReader: { search(query: string, topK?: number): Promise<{ filePath: string; text: string }[]> },
): Promise<string[]> {
  try {
    // 用符号名作为搜索词，限制返回少量结果
    const hits = await indexReader.search(`export ${symbolName}`, 5);
    const candidates: string[] = [];
    for (const h of hits) {
      if (h.filePath === excludeFile) continue;
      // 确认文本中确实包含该符号的导出声明
      if (new RegExp(`export\\s+(default\\s+)?(function|class|const|type|interface)\\s+${escapeRegex(symbolName)}`).test(h.text)) {
        candidates.push(h.filePath);
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 编辑后符号引用验证（§8.15.2）。
 * 读取文件内容 → 提取 import/require → 在 CodebaseIndex 中搜索同名导出。
 *
 * @param filePath 被编辑文件的相对路径
 * @param workspaceRoot 工作区根路径
 * @param indexReader CodebaseIndex 读端（可选）
 * @returns 引用问题列表（空 = 全部通过）
 */
export async function verifyReferences(
  filePath: string,
  workspaceRoot: string,
  indexReader?: { search(query: string, topK?: number): Promise<{ filePath: string; text: string }[]> },
): Promise<ReferenceIssue[]> {
  if (!indexReader) return [];

  const { promises: fs } = await import('node:fs');
  const { resolve } = await import('node:path');

  let content: string;
  try {
    content = await fs.readFile(resolve(workspaceRoot, filePath), 'utf-8');
  } catch {
    return []; // 文件不存在 → 跳过
  }

  const refs = extractImportReferences(content);
  if (refs.length === 0) return [];

  const issues: ReferenceIssue[] = [];

  for (const ref of refs) {
    // 跳过 Node 内置模块和第三方包
    if (!ref.modulePath.startsWith('.') && !ref.modulePath.startsWith('/')) continue;

    const candidates = await searchExportInIndex(ref.symbolName, filePath, indexReader);
    if (candidates.length === 0) {
      // 完全没找到 → 记录 issue（无候选）
      issues.push({
        symbolName: ref.symbolName,
        sourceFile: filePath,
        lineNumber: ref.lineNumber,
        referenceType: ref.type,
      });
    }
    // 有候选 → 也表示可能存在导入错误（候选在其他文件中）
    // 属于"不精确但提醒"的警告
  }

  // 去重：同一符号名只报一次
  const seen = new Set<string>();
  return issues.filter(i => {
    const key = `${i.symbolName}:${i.sourceFile}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 格式化验证结果为注入文本 */
export function formatReferenceIssues(issues: ReferenceIssue[]): string {
  const MAX_SHOW = 5;
  const lines = issues.slice(0, MAX_SHOW).map(i =>
    `Warning: \`${i.symbolName}\` is imported but no module exports it. (${i.sourceFile}:${i.lineNumber})`,
  );
  if (issues.length > MAX_SHOW) {
    lines.push(`…及 ${issues.length - MAX_SHOW} 个问题`);
  }
  return `\n\n[Edit Verification]\n${lines.join('\n')}`;
}
