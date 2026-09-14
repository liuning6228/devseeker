/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * SqliteCheckpointStore —— 基于 SQLite 的 checkpoint 持久化（DESIGN §M16.6 + v1.9.0）
 *
 * 替代原 CheckpointStore（基于 JSON 文件），使用单库存储：
 *   .devseeker/data/devseeker-checkpoints.sqlite
 *
 * Schema：
 *   checkpoints(id, session_id, created_at, label, message_count, file_count, total_bytes)
 *   file_blobs(content_hash, bytes, size_bytes)
 *   checkpoint_files(checkpoint_id, rel_path, content_hash, size_bytes, was_deleted, skipped)
 *   legacy_messages(checkpoint_id, messages_json)  -- 老 checkpoint 兼容
 *
 * 优势：
 * - 单库原子事务，GC 一条 SQL 即可完成
 * - WAL 模式支持并发读
 * - better-sqlite3 原生 C 模块，不膨胀 JS 堆
 *
 * 迁移：
 * - 启动时检测 .devseeker/checkpoints/ 目录是否存在
 * - 存在则跑 migrateFromJson()：扫描 JSON 文件写入 SQLite
 * - 成功后重命名 .devseeker/checkpoints → .devseeker/checkpoints.migrated
 * - 迁移失败仅 log.warn，不阻塞启动
 */

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { AgentError, ErrorCodes } from '../errors/index.js';
import { getLogger } from '../../infra/logger.js';
import type {
  Checkpoint,
  CheckpointMeta,
  CheckpointStoreOptions,
  CreateCheckpointArgs,
  FileSnapshot,
  FileSnapshotInput,
  RevertConflict,
  RevertPrecheck,
  RevertResult,
} from '../checkpoints/types.js';
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_PER_SESSION } from '../checkpoints/types.js';
import type { Message } from '../../providers/types.js';
import { openSqliteDatabase, type SqliteDatabaseLike } from './sqlite-db.js';

const log = getLogger('sqlite.checkpoint-store');

const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS checkpoints (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  label         TEXT,
  message_count INTEGER NOT NULL,
  file_count    INTEGER NOT NULL,
  total_bytes   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cp_session_created
  ON checkpoints(session_id, created_at);

CREATE TABLE IF NOT EXISTS file_blobs (
  content_hash TEXT PRIMARY KEY,
  bytes        BLOB NOT NULL,
  size_bytes   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoint_files (
  checkpoint_id TEXT NOT NULL,
  rel_path      TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  was_deleted   INTEGER NOT NULL,
  skipped       INTEGER NOT NULL,
  FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE,
  PRIMARY KEY (checkpoint_id, rel_path)
);

CREATE TABLE IF NOT EXISTS legacy_messages (
  checkpoint_id TEXT PRIMARY KEY,
  messages_json TEXT NOT NULL,
  FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE
);
`;

export interface SqliteCheckpointStoreOptions {
  workspaceRoot: string;
  maxFileBytes?: number;
  maxPerSession?: number;
  /** 是否自动从 JSON 迁移（默认 true） */
  migrateFromJson?: boolean;
}

export class SqliteCheckpointStore {
  private readonly workspaceRoot: string;
  private readonly maxFileBytes: number;
  private readonly maxPerSession: number;
  private readonly migrateFromJson: boolean;
  private db: SqliteDatabaseLike | null = null;
  private dbPath: string;

  constructor(opts: SqliteCheckpointStoreOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxPerSession = opts.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
    this.migrateFromJson = opts.migrateFromJson ?? true;
    this.dbPath = path.join(this.workspaceRoot, '.devseeker', 'data', 'devseeker-checkpoints.sqlite');
  }

  private async getDb(): Promise<SqliteDatabaseLike> {
    if (this.db) return this.db;
    try {
      await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
      this.db = await openSqliteDatabase({ dbPath: this.dbPath });
      this.db.exec(SCHEMA);
      if (this.migrateFromJson) {
        await this.migrateFromJsonDir().catch((e) => {
          log.warn({ err: String(e) }, 'JSON migration failed (non-fatal)');
        });
      }
      return this.db;
    } catch (e) {
      log.error({ err: String(e) }, 'Failed to open checkpoint database');
      throw new AgentError({
        code: ErrorCodes.CHECKPOINT_SAVE_FAIL,
        message: `Failed to open checkpoint database: ${(e as Error).message}`,
        cause: e,
      });
    }
  }

  /**
   * 从 .devseeker/checkpoints/ JSON 目录迁移到 SQLite。
   * 成功后重命名目录为 .devseeker/checkpoints.migrated。
   */
  private async migrateFromJsonDir(): Promise<void> {
    const checkpointsDir = path.join(this.workspaceRoot, '.devseeker', 'checkpoints');
    if (!existsSync(checkpointsDir)) return;

    const migratedMarker = checkpointsDir + '.migrated';
    if (existsSync(migratedMarker)) {
      // 已迁移过，跳过
      return;
    }

    log.info({ dir: checkpointsDir }, 'Starting JSON → SQLite migration');
    const db = await this.getDb();
    let migratedCount = 0;

    try {
      const entries = await fs.readdir(checkpointsDir);
      for (const name of entries) {
        if (name === 'files') continue;
        const sessionDir = path.join(checkpointsDir, name);
        const stat = await fs.stat(sessionDir).catch(() => null);
        if (!stat?.isDirectory()) continue;

        const sessionId = name;
        const indexFile = path.join(sessionDir, 'index.json');
        if (!existsSync(indexFile)) continue;

        const indexRaw = await fs.readFile(indexFile, 'utf-8');
        const index = JSON.parse(indexRaw);
        if (!Array.isArray(index.entries)) continue;

        for (const meta of index.entries) {
          const cpFile = path.join(sessionDir, `${meta.id}.json`);
          if (!existsSync(cpFile)) continue;

          const cpRaw = await fs.readFile(cpFile, 'utf-8');
          const cp = JSON.parse(cpRaw);

          // 插入 checkpoint 元数据
          db.prepare(
            `INSERT OR IGNORE INTO checkpoints(id, session_id, created_at, label, message_count, file_count, total_bytes)
             VALUES(?, ?, ?, ?, ?, ?, ?)`,
          ).run(meta.id, sessionId, meta.createdAt, meta.label ?? null, meta.messageCount, meta.fileCount, meta.totalBytes);

          // 插入文件快照
          if (Array.isArray(cp.fileSnapshots)) {
            for (const snap of cp.fileSnapshots) {
              db.prepare(
                `INSERT OR IGNORE INTO checkpoint_files(checkpoint_id, rel_path, content_hash, size_bytes, was_deleted, skipped)
                 VALUES(?, ?, ?, ?, ?, ?)`,
              ).run(meta.id, snap.relPath, snap.contentHash, snap.sizeBytes, snap.wasDeleted ? 1 : 0, snap.skipped ? 1 : 0);
            }
          }

          // 老格式：存储 messages（如果有）
          if (Array.isArray(cp.messages) && cp.messages.length > 0) {
            db.prepare(
              `INSERT OR IGNORE INTO legacy_messages(checkpoint_id, messages_json) VALUES(?, ?)`,
            ).run(meta.id, JSON.stringify(cp.messages));
          }

          migratedCount++;
        }
      }

      // 迁移 files/ 内容池
      const filesDir = path.join(checkpointsDir, 'files');
      if (existsSync(filesDir)) {
        const files = await fs.readdir(filesDir);
        for (const hash of files) {
          const filePath = path.join(filesDir, hash);
          const content = await fs.readFile(filePath);
          db.prepare(
            `INSERT OR IGNORE INTO file_blobs(content_hash, bytes, size_bytes) VALUES(?, ?, ?)`,
          ).run(hash, content, content.length);
        }
        log.info({ count: files.length }, 'Migrated file_blobs pool');
      }

      // 重命名目录标记已迁移
      await fs.rename(checkpointsDir, migratedMarker);
      log.info({ migratedCount }, 'JSON → SQLite migration completed');
    } catch (e) {
      log.warn({ err: String(e), migratedCount }, 'JSON migration failed');
      throw e;
    }
  }

  async create(args: CreateCheckpointArgs): Promise<Checkpoint> {
    if (!args.sessionId) {
      throw new AgentError({
        code: ErrorCodes.CHECKPOINT_SAVE_FAIL,
        message: 'sessionId is required',
      });
    }
    const db = await this.getDb();
    const id = newCheckpointId();
    const createdAt = Date.now();

    // 写入文件快照（去重 + 跳过过大文件）
    const fileSnapshots: FileSnapshot[] = [];
    let totalBytes = 0;
    if (args.files && args.files.length > 0) {
      for (const f of args.files) {
        const snap = await this.storeFile(db, f);
        fileSnapshots.push(snap);
        if (!snap.skipped && !snap.wasDeleted) totalBytes += snap.sizeBytes;
      }
    }

    // 插入 checkpoint 元数据
    db.prepare(
      `INSERT INTO checkpoints(id, session_id, created_at, label, message_count, file_count, total_bytes)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, args.sessionId, createdAt, args.label ?? null, args.messages.length, fileSnapshots.length, totalBytes);

    // 插入文件关联
    for (const snap of fileSnapshots) {
      db.prepare(
        `INSERT INTO checkpoint_files(checkpoint_id, rel_path, content_hash, size_bytes, was_deleted, skipped)
         VALUES(?, ?, ?, ?, ?, ?)`,
      ).run(id, snap.relPath, snap.contentHash, snap.sizeBytes, snap.wasDeleted ? 1 : 0, snap.skipped ? 1 : 0);
    }

    // v1.9.0: 不再存储 messages（revert 时从 session store 按 messageCount 切片）

    // 裁剪
    await this.prune(args.sessionId, this.maxPerSession).catch((e) => {
      log.warn({ err: String(e) }, 'prune after create failed');
    });

    return {
      id,
      sessionId: args.sessionId,
      createdAt,
      ...(args.label !== undefined ? { label: args.label } : {}),
      messageCount: args.messages.length,
      fileCount: fileSnapshots.length,
      totalBytes,
      fileSnapshots,
    };
  }

  private async storeFile(db: SqliteDatabaseLike, input: FileSnapshotInput): Promise<FileSnapshot> {
    const { relPath, content } = input;
    if (content === null) {
      return { relPath, contentHash: '', sizeBytes: 0, wasDeleted: true };
    }
    const buf = Buffer.from(content, 'utf-8');
    const sizeBytes = buf.length;
    if (sizeBytes > this.maxFileBytes) {
      return { relPath, contentHash: '', sizeBytes, wasDeleted: false, skipped: true };
    }
    const contentHash = createHash('sha256').update(buf).digest('hex');
    // 插入 file_blobs（去重）
    db.prepare(
      `INSERT OR IGNORE INTO file_blobs(content_hash, bytes, size_bytes) VALUES(?, ?, ?)`,
    ).run(contentHash, buf, sizeBytes);
    return { relPath, contentHash, sizeBytes, wasDeleted: false };
  }

  async list(sessionId: string): Promise<CheckpointMeta[]> {
    const db = await this.getDb();
    try {
      const rows = db.prepare(
        `SELECT id, session_id, created_at, label, message_count, file_count, total_bytes
         FROM checkpoints WHERE session_id = ? ORDER BY created_at`,
      ).all(sessionId) as Array<{
        id: string;
        session_id: string;
        created_at: number;
        label: string | null;
        message_count: number;
        file_count: number;
        total_bytes: number;
      }>;
      return rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        createdAt: r.created_at,
        ...(r.label !== null ? { label: r.label } : {}),
        messageCount: r.message_count,
        fileCount: r.file_count,
        totalBytes: r.total_bytes,
      }));
    } catch (e) {
      log.warn({ err: String(e), sessionId }, 'list failed');
      return [];
    }
  }

  async get(id: string, sessionId: string): Promise<Checkpoint | undefined> {
    const db = await this.getDb();
    const row = db.prepare(
      `SELECT id, session_id, created_at, label, message_count, file_count, total_bytes
       FROM checkpoints WHERE id = ? AND session_id = ?`,
    ).get(id, sessionId) as
      | {
          id: string;
          session_id: string;
          created_at: number;
          label: string | null;
          message_count: number;
          file_count: number;
          total_bytes: number;
        }
      | undefined;
    if (!row) return undefined;

    // 读文件快照
    const fileRows = db.prepare(
      `SELECT rel_path, content_hash, size_bytes, was_deleted, skipped
       FROM checkpoint_files WHERE checkpoint_id = ?`,
    ).all(id) as Array<{
      rel_path: string;
      content_hash: string;
      size_bytes: number;
      was_deleted: number;
      skipped: number;
    }>;
    const fileSnapshots: FileSnapshot[] = fileRows.map((f) => ({
      relPath: f.rel_path,
      contentHash: f.content_hash,
      sizeBytes: f.size_bytes,
      wasDeleted: f.was_deleted === 1,
      ...(f.skipped === 1 ? { skipped: true } : {}),
    }));

    // 读老格式 messages（如果有）
    const legacyRow = db.prepare(
      `SELECT messages_json FROM legacy_messages WHERE checkpoint_id = ?`,
    ).get(id) as { messages_json: string } | undefined;
    const messages: Message[] | undefined = legacyRow ? JSON.parse(legacyRow.messages_json) : undefined;

    return {
      id: row.id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      ...(row.label !== null ? { label: row.label } : {}),
      messageCount: row.message_count,
      fileCount: row.file_count,
      totalBytes: row.total_bytes,
      fileSnapshots,
      ...(messages ? { messages } : {}),
    };
  }

  async revert(args: {
    id: string;
    sessionId: string;
    applyFiles?: boolean;
    onConflict?: 'overwrite' | 'skip' | 'abort';
    currentMessages: Message[];
  }): Promise<RevertResult> {
    const cp = await this.get(args.id, args.sessionId);
    if (!cp) {
      throw new AgentError({
        code: ErrorCodes.CHECKPOINT_RESTORE_FAIL,
        message: `checkpoint not found: ${args.id}`,
      });
    }

    let filesApplied = 0;
    let filesDeleted = 0;
    let filesSkipped = 0;
    const strategy = args.onConflict ?? 'overwrite';

    // 预检查冲突（简化版，不实现完整 precheck）
    const conflictSet = new Set<string>();

    if (args.applyFiles !== false) {
      const db = await this.getDb();
      for (const snap of cp.fileSnapshots) {
        if (snap.skipped) {
          filesSkipped++;
          continue;
        }
        const abs = this.resolveSafe(snap.relPath);
        if (!abs) {
          filesSkipped++;
          continue;
        }
        if (strategy === 'skip' && conflictSet.has(snap.relPath)) {
          filesSkipped++;
          continue;
        }
        if (snap.wasDeleted) {
          try {
            if (existsSync(abs)) await fs.rm(abs, { force: true });
            filesDeleted++;
          } catch (e) {
            log.warn({ err: String(e), relPath: snap.relPath }, 'revert delete failed');
            filesSkipped++;
          }
        } else {
          // 从 file_blobs 读出内容
          const blobRow = db.prepare(
            `SELECT bytes FROM file_blobs WHERE content_hash = ?`,
          ).get(snap.contentHash) as { bytes: Buffer } | undefined;
          if (blobRow) {
            try {
              await fs.mkdir(path.dirname(abs), { recursive: true });
              await fs.writeFile(abs, blobRow.bytes, 'utf-8');
              filesApplied++;
            } catch (e) {
              log.warn({ err: String(e), relPath: snap.relPath }, 'revert apply failed');
              filesSkipped++;
            }
          }
        }
      }
    }

    // v1.9.0: 优先使用存储的 messages（老格式兼容），否则从 currentMessages 按 messageCount 切片
    const restoredMessages =
      cp.messages && cp.messages.length > 0
        ? cp.messages
        : args.currentMessages.slice(0, cp.messageCount);

    return {
      messages: restoredMessages,
      filesApplied,
      filesDeleted,
      filesSkipped,
    };
  }

  async delete(id: string, sessionId: string): Promise<boolean> {
    const db = await this.getDb();
    const result = db.prepare(`DELETE FROM checkpoints WHERE id = ? AND session_id = ?`).run(id, sessionId);
    return result.changes > 0;
  }

  async prune(sessionId: string, maxCount: number): Promise<number> {
    const db = await this.getDb();
    const all = await this.list(sessionId);
    if (all.length <= maxCount) return 0;
    const victims = all.slice(0, all.length - maxCount);
    let removed = 0;
    for (const v of victims) {
      const result = db.prepare(`DELETE FROM checkpoints WHERE id = ?`).run(v.id);
      if (result.changes > 0) removed++;
    }
    return removed;
  }

  async gcOlderThan(
    olderThanDays: number,
    now: number = Date.now(),
  ): Promise<{ removedCheckpoints: number; removedPoolEntries: number }> {
    if (olderThanDays <= 0) {
      return { removedCheckpoints: 0, removedPoolEntries: 0 };
    }
    const db = await this.getDb();
    const cutoff = now - olderThanDays * 24 * 60 * 60 * 1000;
    const result = db.prepare(`DELETE FROM checkpoints WHERE created_at < ?`).run(cutoff);
    const removedCheckpoints = result.changes;
    const removedPoolEntries = await this.gcOrphanPoolFiles().catch(() => 0);
    return { removedCheckpoints, removedPoolEntries };
  }

  async gcOrphanPoolFiles(): Promise<number> {
    const db = await this.getDb();
    // 找出未被任何 checkpoint_files 引用的 file_blobs
    const orphans = db.prepare(
      `SELECT content_hash FROM file_blobs
       WHERE content_hash NOT IN (SELECT DISTINCT content_hash FROM checkpoint_files)`,
    ).all() as Array<{ content_hash: string }>;
    let removed = 0;
    for (const o of orphans) {
      const result = db.prepare(`DELETE FROM file_blobs WHERE content_hash = ?`).run(o.content_hash);
      if (result.changes > 0) removed++;
    }
    return removed;
  }

  private resolveSafe(relPath: string): string | undefined {
    if (!relPath || path.isAbsolute(relPath) || relPath.includes('..')) return undefined;
    return path.join(this.workspaceRoot, relPath);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

function newCheckpointId(): string {
  return `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

