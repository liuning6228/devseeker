/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 内存向量库（W3 批次 1）
 *
 * - 存储 chunk + vector
 * - cosine 相似度 topK 查询
 * - JSON 持久化（vectors 用 Array<number>，避免 Buffer 依赖）
 * - 按 filePath 删除（增量更新时用）
 *
 * 容量约束：1 万条 × 1024 维 × 8B ≈ 80 MB，MVP 阶段可接受。
 * 后续 W3b3 可替换为 LanceDB/sqlite-vss。
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { AgentError, ErrorCodes } from '../errors/index.js';

export interface VectorRecord {
  /** 全局唯一 id（建议 `${filePath}#${startLine}-${endLine}`） */
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /**
   * chunk 文本（结果页展示用）。
   * 新索引不再存储 text，改为搜索命中后从磁盘实时读取；
   * 仅为兼容旧 JSON 快照保留 optional。
   */
  text?: string;
  /** 向量（长度固定） */
  vector: number[];
}

export interface SearchHit {
  record: VectorRecord;
  score: number; // 1 = 完全相同；0 = 正交
}

export interface VectorStoreSnapshot {
  version: 1;
  dimension: number;
  modelId: string;
  createdAt: number;
  updatedAt: number;
  records: VectorRecord[];
}

export class InMemoryVectorStore {
  private records: VectorRecord[] = [];
  private createdAt: number;
  private updatedAt: number;

  constructor(
    readonly dimension: number,
    readonly modelId: string,
  ) {
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
  }

  size(): number {
    return this.records.length;
  }

  /** 覆盖式插入：同 id 会替换 */
  upsert(records: VectorRecord[]): void {
    if (!records.length) return;
    const index = new Map<string, number>();
    this.records.forEach((r, i) => index.set(r.id, i));

    for (const r of records) {
      if (r.vector.length !== this.dimension) {
        throw new AgentError({
          code: ErrorCodes.INDEX_DB_WRITE_FAIL,
          message: `向量维度不匹配：期望 ${this.dimension}，实际 ${r.vector.length}`,
        });
      }
      const existing = index.get(r.id);
      if (existing != null) {
        this.records[existing] = r;
      } else {
        index.set(r.id, this.records.length);
        this.records.push(r);
      }
    }
    this.updatedAt = Date.now();
  }

  /** 按 filePath 清除该文件所有 chunk（增量更新前置） */
  deleteByFile(filePath: string): number {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.filePath !== filePath);
    const removed = before - this.records.length;
    if (removed > 0) this.updatedAt = Date.now();
    return removed;
  }

  clear(): void {
    this.records = [];
    this.updatedAt = Date.now();
  }

  /** 列出所有已索引文件（去重） */
  listIndexedFiles(): string[] {
    return Array.from(new Set(this.records.map((r) => r.filePath))).sort();
  }

  /** top-K cosine 相似度检索 */
  search(queryVector: number[], topK = 10): SearchHit[] {
    if (queryVector.length !== this.dimension) {
      throw new AgentError({
        code: ErrorCodes.INDEX_EMBED_INPUT_TOO_LONG,
        message: `查询向量维度不匹配：期望 ${this.dimension}，实际 ${queryVector.length}`,
      });
    }
    if (!this.records.length || topK <= 0) return [];

    const qNorm = l2norm(queryVector);
    if (qNorm === 0) return [];

    // 线性扫描；MVP 数据量可接受
    const scored: SearchHit[] = [];
    for (const r of this.records) {
      const score = cosine(queryVector, r.vector, qNorm);
      scored.push({ record: r, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  toSnapshot(): VectorStoreSnapshot {
    return {
      version: 1,
      dimension: this.dimension,
      modelId: this.modelId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      records: this.records,
    };
  }

  static fromSnapshot(snap: VectorStoreSnapshot): InMemoryVectorStore {
    if (snap.version !== 1) {
      throw new AgentError({
        code: ErrorCodes.INDEX_DB_CORRUPTED,
        message: `未知 VectorStore 快照版本：${snap.version}`,
      });
    }
    const store = new InMemoryVectorStore(snap.dimension, snap.modelId);
    store.createdAt = snap.createdAt;
    store.updatedAt = snap.updatedAt;
    store.records = snap.records.slice();
    return store;
  }

  async saveToFile(path: string): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    const json = JSON.stringify(this.toSnapshot());
    await fs.writeFile(path, json, 'utf-8');
  }

  /** 索引文件大小上限（字节）：超过此值拒绝加载，防止大文件导致 OOM */
  private static readonly MAX_INDEX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

  static async loadFromFile(path: string): Promise<InMemoryVectorStore | undefined> {
    // P0-7 · 大文件保护：先检查文件大小，避免一次性读取几百 MB 导致 Extension Host OOM
    try {
      const st = await fs.stat(path);
      if (st.size > InMemoryVectorStore.MAX_INDEX_FILE_SIZE) {
        // eslint-disable-next-line no-console
        console.warn(`[P0-7] codebase-index.json too large (${Math.round(st.size / 1024 / 1024)}MB), skipping load. Run "Reindex Codebase" to rebuild.`);
        return undefined;
      }
    } catch {
      // stat 失败（文件不存在等）继续走下方 readFile 的 ENOENT 处理
    }
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf-8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      throw new AgentError({
        code: ErrorCodes.INDEX_DB_CORRUPTED,
        message: `读取向量库失败: ${(e as Error).message}`,
      });
    }
    let snap: VectorStoreSnapshot;
    try {
      snap = JSON.parse(raw) as VectorStoreSnapshot;
    } catch (e) {
      throw new AgentError({
        code: ErrorCodes.INDEX_DB_CORRUPTED,
        message: `向量库 JSON 解析失败: ${(e as Error).message}`,
      });
    }
    return InMemoryVectorStore.fromSnapshot(snap);
  }
}

// ─────────── helpers ───────────

function l2norm(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

function cosine(a: number[], b: number[], aNorm?: number): number {
  let dot = 0;
  let bSum = 0;
  const an = aNorm ?? l2norm(a);
  if (an === 0) return 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    bSum += b[i] * b[i];
  }
  const bn = Math.sqrt(bSum);
  if (bn === 0) return 0;
  return dot / (an * bn);
}
