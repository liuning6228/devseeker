/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * AssetIndexer —— 非代码资产索引协调器（C1 文档画像引擎）
 *
 * 实现 IndexReader 契约,与 CodebaseIndex / Bm25CodebaseIndex 共享统一检索接口。
 *
 * 设计：
 * - 一期仅支持 PDF 提取，图片/ SVG 为二期
 * - 内部使用 BM25 做 lexical 检索（零模型，冷启动 < 50ms）
 * - 索引快照落盘为 JSON（`.devseeker/asset-index/snapshot.json`）
 * - search() 返回与 CodebaseIndex 一致的 SearchResult[]（修复适配问题 P3）
 *
 * 生命周期：
 *   const indexer = new AssetIndexer(workspaceRoot);
 *   await indexer.reindex();   // 扫描工作区，提取所有 PDF/图片
 *   const hits = await indexer.search('关键词');  // 检索
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type { AssetMeta, SearchResult, IndexReader } from './types.js';
import { extractPdf } from './pdf.js';
import { extractWithLiteParse, isLiteParseAvailable } from './liteparse.js';

/** 资产索引快照目录（相对 workspaceRoot） */
const ASSET_INDEX_REL = '.devseeker/asset-index';
/** 快照文件名 */
const SNAPSHOT_FILE = 'snapshot.json';

/** 默认支持扫描的资产扩展名（一期: PDF + 图片 + SVG） */
export const ASSET_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.svg']);

/** 默认忽略目录（与 scanner.ts 一致） */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build',
  '.next', '.nuxt', '.cache', '.turbo', '.parcel-cache', 'coverage',
  '__pycache__', '.venv', 'venv', 'target', '.vscode-test', '.devseeker',
  '.idea', '.DS_Store',
]);

export interface AssetIndexerOptions {
  workspaceRoot: string;
}

export class AssetIndexer {
  private readonly workspaceRoot: string;
  /** 相对路径 → AssetMeta 的映射 */
  private assets = new Map<string, AssetMeta>();
  /** 关键词 → 文档 ID 列表（BM25 倒排索引） */
  private invertedIndex = new Map<string, Map<string, number>>();
  private indexed = false;

  constructor(opts: AssetIndexerOptions) {
    this.workspaceRoot = opts.workspaceRoot;
  }

  /** 当前索引的资产数 */
  size(): number {
    return this.assets.size;
  }

  /** 列出所有已索引的资产文件路径 */
  listIndexedFiles(): string[] {
    return Array.from(this.assets.keys());
  }

  // ─────────── 检索 ───────────

  /**
   * 在资产索引中检索。
   * 返回 SearchResult[]，与 CodebaseIndex.search 类型一致。
   */
  async search(query: string, topK = 10): Promise<SearchResult[]> {
    if (!this.indexed || this.assets.size === 0) return [];

    const terms = tokenize(query);
    if (terms.length === 0) return [];

    // BM25 打分
    const scores = new Map<string, number>(); // relPath → score
    const totalDocs = this.assets.size;

    for (const term of terms) {
      const postingList = this.invertedIndex.get(term);
      if (!postingList) continue;

      const df = postingList.size;
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));

      for (const [relPath, tf] of postingList) {
        // 简单 BM25（k1=1.5, b=0.75 使用固定 docLen 简化）
        const k1 = 1.5;
        const score = idf * ((tf * (k1 + 1)) / (tf + k1));
        scores.set(relPath, (scores.get(relPath) ?? 0) + score);
      }
    }

    // 排序 + 截断
    const ranked = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    return ranked.map(([relPath, score]) => {
      const meta = this.assets.get(relPath)!;
      const text = meta.description.slice(0, 2000);
      return {
        filePath: relPath,
        startLine: 1,
        endLine: text.split('\n').length,
        text,
        score,
      };
    });
  }

  // ─────────── 索引 ───────────

  /** 全量重建索引：扫描工作区中所有 PDF/图片文件，提取文本并建立倒排索引 */
  async reindex(): Promise<void> {
    this.assets.clear();
    this.invertedIndex.clear();

    const files = await this.scanAssets();
    for (const relPath of files) {
      const absPath = path.resolve(this.workspaceRoot, relPath);
      const meta = await this.extractFile(absPath, relPath);
      if (meta && meta.description.trim()) {
        this.assets.set(relPath, meta);
        this.indexDescription(relPath, meta.description);
      }
    }

    this.indexed = true;
    await this.saveSnapshot();
  }

  /** 更新单个文件（Watcher 增量用） */
  async updateFile(relPath: string): Promise<{ removed: number; added: number }> {
    const removed = this.assets.has(relPath) ? 1 : 0;
    this.assets.delete(relPath);
    this.removeFromInvertedIndex(relPath);

    const absPath = path.resolve(this.workspaceRoot, relPath);
    const meta = await this.extractFile(absPath, relPath);
    if (meta && meta.description.trim()) {
      this.assets.set(relPath, meta);
      this.indexDescription(relPath, meta.description);
    }

    await this.saveSnapshot();
    return { removed, added: this.assets.has(relPath) ? 1 : 0 };
  }

  /** 移除文件 */
  removeFile(relPath: string): { removed: number; added: number } {
    const removed = this.assets.has(relPath) ? 1 : 0;
    this.assets.delete(relPath);
    this.removeFromInvertedIndex(relPath);
    return { removed, added: 0 };
  }

  /** 持久化快照 */
  async save(): Promise<void> {
    await this.saveSnapshot();
  }

  // ─────────── 私有 ───────────

  private async scanAssets(): Promise<string[]> {
    const results: string[] = [];

    async function walk(dir: string, root: string): Promise<void> {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true }) as import('node:fs').Dirent[];
      } catch {
        return;
      }
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath, root);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ASSET_EXTENSIONS.has(ext)) {
            results.push(path.relative(root, fullPath).replace(/\\/g, '/'));
          }
        }
      }
    }

    await walk(this.workspaceRoot, this.workspaceRoot);
    return results;
  }

  private async extractFile(absPath: string, relPath: string): Promise<AssetMeta | null> {
    const ext = path.extname(relPath).toLowerCase();
    try {
      // 优先使用 LiteParse（更强: 支持 OCR/布局/DOCX/图片）
      if (await isLiteParseAvailable()) {
        const result = await extractWithLiteParse(absPath, relPath);
        if (result) return result;
      }

      // 降级到 pdfjs-dist（仅 PDF）
      if (ext === '.pdf') return await extractPdf(absPath, relPath);

      // 图片和 SVG 为二期
      return null;
    } catch {
      return null;
    }
  }

  /** 对描述文本建立倒排索引 */
  private indexDescription(relPath: string, text: string): void {
    const terms = tokenize(text);
    const freq = new Map<string, number>();
    for (const term of terms) {
      freq.set(term, (freq.get(term) ?? 0) + 1);
    }
    for (const [term, tf] of freq) {
      let postingList = this.invertedIndex.get(term);
      if (!postingList) {
        postingList = new Map();
        this.invertedIndex.set(term, postingList);
      }
      postingList.set(relPath, tf);
    }
  }

  private removeFromInvertedIndex(relPath: string): void {
    for (const postingList of this.invertedIndex.values()) {
      postingList.delete(relPath);
    }
  }

  private async saveSnapshot(): Promise<void> {
    const dir = path.resolve(this.workspaceRoot, ASSET_INDEX_REL);
    await fsp.mkdir(dir, { recursive: true });
    const data = {
      assets: Array.from(this.assets.values()),
      updatedAt: Date.now(),
    };
    await fsp.writeFile(path.join(dir, SNAPSHOT_FILE), JSON.stringify(data, null, 2), 'utf-8');
  }
}

// ─────────── 工具函数 ───────────

/** 简单分词：按非字母数字切分，转小写，过滤长度 < 2 的停用词 */
function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-zA-Z0-9\u4e00-\u9fff]+/)
    .filter(t => t.length >= 2);
  const stopwords = new Set([
    'the', 'this', 'that', 'and', 'are', 'for', 'not', 'but', 'with',
    'from', 'they', 'will', 'have', 'been', 'was', 'were', 'has', 'had',
    'which', 'what', 'when', 'where', 'how', 'all', 'each', 'can', 'its',
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
    '一', '一个', '上', '也', '很', '到', '那', '要', '下', '看', '这',
  ]);
  return tokens.filter(t => !stopwords.has(t));
}
