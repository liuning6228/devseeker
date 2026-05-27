/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W3b3 · SQLite 向量存储（替代 InMemoryVectorStore + JSON 全量加载）
 *
 * 设计要点：
 * - 向量存为 BLOB（Float32Array，4B/维度），比 JSON number[]（8B/维度）省一半
 * - 搜索时从 SQLite 按需读取记录 + 向量，不全量加载到内存
 * - 复用项目已有的 better-sqlite3 连接（与 sessions/usage 同库）
 * - 兼容旧 JSON 格式：首次启动自动迁移 codebase-index.json → SQLite
 *
 * 内存占用：激活时仅 SQLite 页缓存（几 MB），搜索时按需读取
 * — 彻底消除大索引 OOM 风险（原 JSON 全量加载 487MB → 2.4GB 堆内存）
 */

import { promises as fs } from 'node:fs';
import type { SqliteDatabaseLike, SqliteStmtLike } from '../storage/sqlite-db.js';
import type { VectorRecord, SearchHit, VectorStoreSnapshot } from './vector-store.js';
import { AgentError, ErrorCodes } from '../errors/index.js';
import { getLogger } from '../../infra/logger.js';

// 在 C 层注册 cosine_distance SQL 函数（better-sqlite3 专属）
let _cosineRegistered = false;
function ensureCosineFunction(db: SqliteDatabaseLike): void {
  if (_cosineRegistered) return;
  // 通过 duck typing 获取 better-sqlite3 底层的 Database（非 bsqlite3Db 包装层）
  const raw = (db as unknown as { db?: BSqliteDb }).db;
  if (!raw || typeof (raw as unknown as { function?: unknown }).function !== 'function') return;
  raw.function('cosine_distance', (vecBlob: unknown, queryBlob: unknown, dim: unknown) => {
    if (!Buffer.isBuffer(vecBlob) || !Buffer.isBuffer(queryBlob) || typeof dim !== 'number') return 0;
    const dimension = dim;
    const a = new Float32Array(vecBlob.buffer, vecBlob.byteOffset, vecBlob.byteLength / 4);
    const b = new Float32Array(queryBlob.buffer, queryBlob.byteOffset, queryBlob.byteLength / 4);
    let dot = 0, aNorm = 0, bNorm = 0;
    for (let i = 0; i < dimension; i++) {
      dot += a[i] * b[i];
      aNorm += a[i] * a[i];
      bNorm += b[i] * b[i];
    }
    const denom = Math.sqrt(aNorm) * Math.sqrt(bNorm);
    return denom === 0 ? 0 : dot / denom;
  });
  _cosineRegistered = true;
}

const log = getLogger('sqlite-vector-store');

// ─────────── Schema ───────────

const VEC_SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS vec_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vec_records (
  id        TEXT PRIMARY KEY,
  filePath  TEXT NOT NULL,
  startLine INTEGER NOT NULL,
  endLine   INTEGER NOT NULL,
  text      TEXT,
  vector    BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vec_filePath ON vec_records(filePath);
`;

// ─────────── Helpers ───────────

/** number[] → Float32Array → Buffer (BLOB) */
function vectorToBlob(vec: number[]): Buffer {
  const f32 = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) f32[i] = vec[i];
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** Buffer (BLOB) → number[] */
function blobToVector(blob: Buffer, expectedDim: number): number[] {
  const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  if (f32.length !== expectedDim) {
    throw new AgentError({
      code: ErrorCodes.INDEX_DB_CORRUPTED,
      message: `向量维度不匹配：期望 ${expectedDim}，实际 ${f32.length}`,
    });
  }
  return Array.from(f32);
}

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

// ─────────── SqliteVectorStore ───────────

export interface SqliteVectorStoreOptions {
  db: SqliteDatabaseLike;
  dimension: number;
  modelId: string;
  /** 旧 JSON 索引路径（用于自动迁移）；不传则跳过迁移 */
  legacyJsonPath?: string;
}

/** better-sqlite3 原生 Database 类型（仅用于 duck-typing 检测） */
type BSqliteDb = import('better-sqlite3').Database;

export class SqliteVectorStore {
  private readonly db: SqliteDatabaseLike;
  private readonly dimension: number;
  private readonly modelId: string;

  /** 预编译语句（lazy init） */
  private _upsertStmt?: SqliteStmtLike;
  private _deleteByFileStmt?: SqliteStmtLike;
  private _clearStmt?: SqliteStmtLike;
  private _sizeStmt?: SqliteStmtLike;
  private _allStmt?: SqliteStmtLike;
  private _filesStmt?: SqliteStmtLike;
  private _getMetaStmt?: SqliteStmtLike;
  private _setMetaStmt?: SqliteStmtLike;
  /** SQL 级搜索的结果缓存（_trySqlSearch 写入） */
  private _lastResult: SearchHit[] | undefined;

  constructor(opts: SqliteVectorStoreOptions) {
    this.db = opts.db;
    this.dimension = opts.dimension;
    this.modelId = opts.modelId;
    // 确保 vec 表存在
    this.db.exec(VEC_SCHEMA);
  }

  // ─────────── 预编译语句懒加载 ───────────

  private get upsertStmt(): SqliteStmtLike {
    if (!this._upsertStmt) {
      this._upsertStmt = this.db.prepare(
        `INSERT INTO vec_records(id, filePath, startLine, endLine, vector)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           filePath  = excluded.filePath,
           startLine = excluded.startLine,
           endLine   = excluded.endLine,
           vector    = excluded.vector`,
      );
    }
    return this._upsertStmt;
  }

  private get deleteByFileStmt(): SqliteStmtLike {
    if (!this._deleteByFileStmt) {
      this._deleteByFileStmt = this.db.prepare('DELETE FROM vec_records WHERE filePath = ?');
    }
    return this._deleteByFileStmt;
  }

  private get clearStmt(): SqliteStmtLike {
    if (!this._clearStmt) {
      this._clearStmt = this.db.prepare('DELETE FROM vec_records');
    }
    return this._clearStmt;
  }

  private get sizeStmt(): SqliteStmtLike {
    if (!this._sizeStmt) {
      this._sizeStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM vec_records');
    }
    return this._sizeStmt;
  }

  private get allStmt(): SqliteStmtLike {
    if (!this._allStmt) {
      this._allStmt = this.db.prepare('SELECT id, filePath, startLine, endLine, vector FROM vec_records');
    }
    return this._allStmt;
  }

  private get filesStmt(): SqliteStmtLike {
    if (!this._filesStmt) {
      this._filesStmt = this.db.prepare('SELECT DISTINCT filePath FROM vec_records ORDER BY filePath');
    }
    return this._filesStmt;
  }

  private get getMetaStmt(): SqliteStmtLike {
    if (!this._getMetaStmt) {
      this._getMetaStmt = this.db.prepare('SELECT value FROM vec_meta WHERE key = ?');
    }
    return this._getMetaStmt;
  }

  private get setMetaStmt(): SqliteStmtLike {
    if (!this._setMetaStmt) {
      this._setMetaStmt = this.db.prepare(
        `INSERT INTO vec_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
    }
    return this._setMetaStmt;
  }

  // ─────────── Meta helpers ───────────

  private getMeta(key: string): string | undefined {
    const row = this.getMetaStmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.setMetaStmt.run(key, value);
  }

  // ─────────── Public API ───────────

  size(): number {
    const row = this.sizeStmt.get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /** 覆盖式插入：同 id 会替换 */
  upsert(records: VectorRecord[]): void {
    if (!records.length) return;
    // 在一个事务中批量写入，避免逐条 autocommit 开销
    this.db.exec('BEGIN');
    try {
      for (const r of records) {
        if (r.vector.length !== this.dimension) {
          this.db.exec('ROLLBACK');
          throw new AgentError({
            code: ErrorCodes.INDEX_DB_WRITE_FAIL,
            message: `向量维度不匹配：期望 ${this.dimension}，实际 ${r.vector.length}`,
          });
        }
        const blob = vectorToBlob(r.vector);
        this.upsertStmt.run(r.id, r.filePath, r.startLine, r.endLine, blob);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw e;
    }
    this.setMeta('updatedAt', String(Date.now()));
  }

  /** 按 filePath 清除该文件所有 chunk（增量更新前置） */
  deleteByFile(filePath: string): number {
    const result = this.deleteByFileStmt.run(filePath);
    const removed = result.changes;
    if (removed > 0) this.setMeta('updatedAt', String(Date.now()));
    return removed;
  }

  clear(): void {
    this.clearStmt.run();
    this.setMeta('updatedAt', String(Date.now()));
  }

  /** 列出所有已索引文件（去重） */
  listIndexedFiles(): string[] {
    const rows = this.filesStmt.all() as Array<{ filePath: string }>;
    return rows.map((r) => r.filePath);
  }

  /** top-K cosine 相似度检索 */
  search(queryVector: number[], topK = 10): SearchHit[] {
    if (queryVector.length !== this.dimension) {
      throw new AgentError({
        code: ErrorCodes.INDEX_EMBED_INPUT_TOO_LONG,
        message: `查询向量维度不匹配：期望 ${this.dimension}，实际 ${queryVector.length}`,
      });
    }
    if (topK <= 0) return [];

    // 优先使用 C 层 cosine_distance 函数（better-sqlite3 专属，按页扫描不反序列化到 JS）
    if (this._trySqlSearch(queryVector, topK)) {
      return this._lastResult!;
    }

    // fallback：JS 层全表扫描（sql.js / in-memory 路径）
    return this._jsFallbackSearch(queryVector, topK);
  }

  /** 尝试 SQL 级 cosine 搜索（better-sqlite3 专属）。成功返回 true，_lastResult 被填充。 */
  private _trySqlSearch(queryVector: number[], topK: number): boolean {
    const raw = (this.db as unknown as { db?: BSqliteDb }).db;
    if (!raw || typeof (raw as unknown as { function?: unknown }).function !== 'function') return false;
    ensureCosineFunction(this.db);

    const qBlob = vectorToBlob(queryVector);
    try {
      const rows = this.db.prepare(`
        SELECT id, filePath, startLine, endLine,
               cosine_distance(vector, ?, ?) AS score
        FROM vec_records
        ORDER BY score DESC
        LIMIT ?
      `).all(qBlob, this.dimension, topK) as Array<{
        id: string; filePath: string; startLine: number; endLine: number;
        score: number;
      }>;

      this._lastResult = rows.map((r) => ({
        record: {
          id: r.id,
          filePath: r.filePath,
          startLine: r.startLine,
          endLine: r.endLine,
          vector: [],
        },
        score: r.score,
      }));
      return true;
    } catch {
      return false;
    }
  }

  /** JS 层全表扫描 fallback（sql.js / InMemoryDb 路径） */
  private _jsFallbackSearch(queryVector: number[], topK: number): SearchHit[] {
    const qNorm = l2norm(queryVector);
    if (qNorm === 0) return [];

    const heap: Array<{ id: string; filePath: string; startLine: number; endLine: number; score: number }> = [];
    const iter = this.allStmt.iterate() as IterableIterator<{
      id: string; filePath: string; startLine: number; endLine: number;
      vector: Buffer;
    }>;
    for (const row of iter) {
      try {
        const vec = blobToVector(row.vector, this.dimension);
        const score = cosine(queryVector, vec, qNorm);
        if (heap.length < topK) {
          heap.push({ id: row.id, filePath: row.filePath, startLine: row.startLine, endLine: row.endLine, score });
          if (heap.length === topK) heap.sort((a, b) => a.score - b.score);
        } else if (score > heap[0].score) {
          heap[0] = { id: row.id, filePath: row.filePath, startLine: row.startLine, endLine: row.endLine, score };
          this.siftDown(heap, 0);
        }
      } catch {
        // 维度不匹配的损坏记录跳过
      }
    }

    heap.sort((a, b) => b.score - a.score);
    return heap.map((h) => ({
      record: { id: h.id, filePath: h.filePath, startLine: h.startLine, endLine: h.endLine, vector: [] },
      score: h.score,
    }));
  }

  /**
   * 最小堆下沉操作：将 index 位置的元素下沉到正确位置。
   * 堆性质：parent <= children（最小堆），heap[0] = 最差候选。
   */
  private siftDown(
    heap: Array<{ score: number }>,
    index: number,
  ): void {
    const size = heap.length;
    let i = index;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < size && heap[left].score < heap[smallest].score) smallest = left;
      if (right < size && heap[right].score < heap[smallest].score) smallest = right;
      if (smallest === i) break;
      [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
      i = smallest;
    }
  }

  // ─────────── 迁移 & 兼容 ───────────

  /** SQLite 天然持久化，save 为 no-op */
  async save(): Promise<void> {
    // no-op: SQLite WAL 模式下写入即持久化
  }

  /**
   * 从旧 JSON 索引文件迁移到 SQLite。
   * - 文件 > 100MB 跳过（需用户 reindex）
   * - 迁移成功后重命名为 .migrated
   */
  async migrateFromJson(jsonPath: string): Promise<{ migrated: boolean; count: number }> {
    // 检查是否已迁移
    const alreadyMigrated = this.getMeta('jsonMigrated');
    if (alreadyMigrated === jsonPath) {
      log.info({ jsonPath }, 'sqlite-vector-store: JSON already migrated, skip');
      return { migrated: false, count: 0 };
    }

    // 检查文件是否存在
    let stat;
    try {
      stat = await fs.stat(jsonPath);
    } catch {
      log.debug({ jsonPath }, 'sqlite-vector-store: no legacy JSON to migrate');
      return { migrated: false, count: 0 };
    }

    // 大文件保护
    const MAX_MIGRATE_SIZE = 100 * 1024 * 1024; // 100MB
    if (stat.size > MAX_MIGRATE_SIZE) {
      log.warn(
        { jsonPath, sizeMB: Math.round(stat.size / 1024 / 1024) },
        'sqlite-vector-store: JSON too large to migrate, user needs to reindex',
      );
      return { migrated: false, count: 0 };
    }

    // 读取并解析 JSON
    log.info({ jsonPath, sizeMB: Math.round(stat.size / 1024 / 1024) }, 'sqlite-vector-store: migrating JSON → SQLite');
    let snap: VectorStoreSnapshot;
    try {
      const raw = await fs.readFile(jsonPath, 'utf-8');
      snap = JSON.parse(raw) as VectorStoreSnapshot;
    } catch (e) {
      log.warn({ err: String(e), jsonPath }, 'sqlite-vector-store: JSON parse failed, skip migration');
      return { migrated: false, count: 0 };
    }

    // 检查维度和 modelId 匹配
    if (snap.dimension !== this.dimension || snap.modelId !== this.modelId) {
      log.info(
        { snapDim: snap.dimension, storeDim: this.dimension, snapModel: snap.modelId, storeModel: this.modelId },
        'sqlite-vector-store: JSON model/dimension mismatch, skip migration',
      );
      return { migrated: false, count: 0 };
    }

    // 批量导入
    if (snap.records.length > 0) {
      this.upsert(snap.records);
    }

    // 保存元数据
    this.setMeta('createdAt', String(snap.createdAt));
    this.setMeta('updatedAt', String(snap.updatedAt));
    this.setMeta('modelId', snap.modelId);
    this.setMeta('dimension', String(snap.dimension));
    this.setMeta('jsonMigrated', jsonPath);

    // 重命名旧文件
    const migratedPath = jsonPath + '.migrated';
    try {
      await fs.rename(jsonPath, migratedPath);
      log.info({ jsonPath, migratedPath, count: snap.records.length }, 'sqlite-vector-store: JSON migrated successfully');
    } catch (e) {
      log.warn({ err: String(e), jsonPath }, 'sqlite-vector-store: rename to .migrated failed, but data imported');
    }

    return { migrated: true, count: snap.records.length };
  }

  /**
   * 工厂方法：创建 SqliteVectorStore 并自动从旧 JSON 迁移。
   * 兼容 CodebaseIndex.create() 的调用模式。
   */
  static async create(opts: SqliteVectorStoreOptions): Promise<SqliteVectorStore> {
    const store = new SqliteVectorStore(opts);

    // 检查 SQLite 中是否已有数据
    const existingSize = store.size();
    if (existingSize > 0) {
      // modelId / dimension 漂移检查：不匹配则清空旧数据
      const storedModelId = store.getMeta('modelId');
      if (storedModelId && storedModelId !== opts.modelId) {
        log.info(
          { storedModelId, newModelId: opts.modelId, dimension: opts.dimension },
          'sqlite-vector-store: modelId mismatch, clearing old data',
        );
        store.clear();
      }
      store.setMeta('modelId', opts.modelId);
      store.setMeta('dimension', String(opts.dimension));
      log.info({ size: store.size() }, 'sqlite-vector-store: existing data found in SQLite');
      return store;
    }

    // 初始化 meta
    store.setMeta('modelId', opts.modelId);
    store.setMeta('dimension', String(opts.dimension));

    // 尝试从旧 JSON 迁移
    if (opts.legacyJsonPath) {
      await store.migrateFromJson(opts.legacyJsonPath);
    }

    return store;
  }
}
