/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W14.1+W14.2 · 私有知识库 · KnowledgeIndex
 *
 * 设计目标：
 *   - 只在 `.dualmind/knowledge/**\/*.md` 下做 lexical 检索
 *   - 与 codebase 索引完全分家：单独 store (`.dualmind/knowledge-index.json`)、
 *     单独 workspaceRoot（设为 knowledgeRoot 本身，避免扫到整个仓库）
 *   - 零依赖、零网络、零模型：复用 `Bm25CodebaseIndex` 实现（BM25 作为 bg engine）
 *
 * 取舍（按用户"倾向功能/性能"原则）：
 *   - 不用向量：知识库是短文档 + 关键词驱动场景，BM25 召回率与延迟都优于
 *     e5-small 冷启动（<50ms vs 5s）
 *   - 固定扩展名：仅 `.md` — 避免误把 `.json/.ts` 等噪声文件吸入
 *   - 延后 W14.1 对"向量"的执念：后续如有需要，`embedProvider='dashscope'` 仍可
 *     在单独子类中加回，对现有工具完全透明
 *
 * 工具集成：
 *   - `search_knowledge` 工具（与 `search_codebase` 并列）通过 `IndexReader` 契约读取
 *   - panel 懒加载：首次使用时 create，目录不存在 → `KNOWLEDGE_BASE_EMPTY`（软失败）
 */

import { promises as fs } from 'node:fs';
import {
  Bm25CodebaseIndex,
  type Bm25CodebaseIndexOptions,
  type CodebaseIndexLike,
  type IndexProgress,
  type IndexReader,
  type ReindexStats,
  type SearchResult,
} from '../index/index.js';
import { AgentError, ErrorCodes } from '../errors/index.js';
import { defaultKnowledgeIndexPath, defaultKnowledgeRoot } from './store-path.js';

export interface KnowledgeIndexOptions {
  /** 工作区根目录（用于推导 knowledgeRoot / storePath 默认值）。 */
  workspaceRoot: string;
  /** 覆盖知识库根目录（调试/单测用）。 */
  knowledgeRoot?: string;
  /** 覆盖 BM25 快照路径（调试/单测用）。 */
  storePath?: string;
  /** 透传 BM25 参数。 */
  bm25Params?: Bm25CodebaseIndexOptions['bm25Params'];
  /** 透传进度回调（reindex 时）。 */
  onProgress?: (p: IndexProgress) => void;
  /** 单测注入的文件读取实现。 */
  readFileImpl?: (absPath: string) => Promise<string>;
}

/**
 * 薄封装 `Bm25CodebaseIndex`，对外暴露与 `IndexReader` 一致的契约，
 * 但把 workspaceRoot 换成 `knowledgeRoot`、把 includeExt 锁死到 `.md`。
 */
export class KnowledgeIndex implements CodebaseIndexLike {
  private readonly inner: Bm25CodebaseIndex;
  private readonly knowledgeRoot: string;

  private constructor(inner: Bm25CodebaseIndex, knowledgeRoot: string) {
    this.inner = inner;
    this.knowledgeRoot = knowledgeRoot;
  }

  /**
   * 工厂：若 knowledgeRoot 目录不存在，抛 `KNOWLEDGE_BASE_EMPTY`，
   * 工具层据此做软降级提示（而非 hard fail）。
   */
  static async create(opts: KnowledgeIndexOptions): Promise<KnowledgeIndex> {
    const knowledgeRoot = opts.knowledgeRoot ?? defaultKnowledgeRoot(opts.workspaceRoot);
    const storePath = opts.storePath ?? defaultKnowledgeIndexPath(opts.workspaceRoot);

    // 若知识库目录不存在，抛结构化错误；由工具层决定是软降级还是 hard fail
    try {
      const st = await fs.stat(knowledgeRoot);
      if (!st.isDirectory()) {
        throw new AgentError({
          code: ErrorCodes.KNOWLEDGE_BASE_EMPTY,
          message: `知识库路径不是目录：${knowledgeRoot}`,
        });
      }
    } catch (e) {
      // fs.stat ENOENT → 目录不存在
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new AgentError({
          code: ErrorCodes.KNOWLEDGE_BASE_EMPTY,
          message: `知识库目录不存在：${knowledgeRoot}。请先创建 .dualmind/knowledge/ 并放入 .md 文档。`,
        });
      }
      if (e instanceof AgentError) throw e;
      throw new AgentError({
        code: ErrorCodes.KNOWLEDGE_BASE_EMPTY,
        message: `无法访问知识库目录：${(e as Error).message}`,
      });
    }

    const inner = await Bm25CodebaseIndex.create({
      // 关键：把 workspaceRoot 换成 knowledgeRoot，使得 scanner 只在知识库内递归
      workspaceRoot: knowledgeRoot,
      storePath,
      scanner: {
        // 只索引 .md（避免误吸 .json/.ts 等噪声）
        includeExt: new Set(['.md']),
        // 防爆：单文件 2MB、目录合计 5000 条封顶（文档场景足够）
        maxFileSize: 2 * 1024 * 1024,
        maxFiles: 5000,
      },
      chunker: {
        // 文档段落感强：默认 400 tokens (~1600 chars) 对 markdown 切段过大，
        // 800 chars/2 lines 更贴合文档小节粒度
        maxChars: 800,
        overlapLines: 1,
      },
      bm25Params: opts.bm25Params,
      onProgress: opts.onProgress,
      readFileImpl: opts.readFileImpl,
    });

    return new KnowledgeIndex(inner, knowledgeRoot);
  }

  getKnowledgeRoot(): string {
    return this.knowledgeRoot;
  }

  size(): number {
    return this.inner.size();
  }

  listIndexedFiles(): string[] {
    return this.inner.listIndexedFiles();
  }

  async search(query: string, topK = 10, opts?: { rerank?: boolean }): Promise<SearchResult[]> {
    return this.inner.search(query, topK, opts);
  }

  async reindex(): Promise<ReindexStats> {
    return this.inner.reindex();
  }

  async save(): Promise<void> {
    return this.inner.save();
  }

  async updateFile(relPath: string): Promise<{ removed: number; added: number }> {
    return this.inner.updateFile(relPath);
  }

  removeFile(relPath: string): { removed: number; added: number } {
    return this.inner.removeFile(relPath);
  }
}

/** 只读契约别名，给 `search_knowledge` 工具使用。 */
export type KnowledgeReader = IndexReader;
