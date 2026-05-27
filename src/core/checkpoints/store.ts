/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CheckpointStore
 *
 * 职责：
 * - create(args) 把 messages + 可选的 file 快照 落盘
 * - list(sessionId) / get(id, sessionId) 读取
 * - revert(id) 恢复消息 + 文件到工作区
 * - prune(sessionId, max) 按时间升序裁剪（超上限者连同文件引用一起清）
 *
 * 文件布局：
 *   <workspaceRoot>/.devseeker/checkpoints/
 *     files/<sha256>                      # 全局内容池（跨 session 去重）
 *     <sessionId>/
 *       index.json                        # CheckpointMeta[]
 *       <checkpointId>.json               # Checkpoint（含 messages + fileSnapshots）
 *
 * 线程/并发：
 *   MVP 不加锁。调用方应串行 create / revert。
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
} from './types.js';
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_PER_SESSION } from './types.js';

const log = getLogger('checkpoint.store');

const ROOT_DIR = '.devseeker/checkpoints';
const FILES_DIR = 'files';
const INDEX_FILE = 'index.json';

export class CheckpointStore {
  private readonly workspaceRoot: string;
  private readonly maxFileBytes: number;
  private readonly maxPerSession: number;

  constructor(opts: CheckpointStoreOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxPerSession = opts.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  }

  async create(args: CreateCheckpointArgs): Promise<Checkpoint> {
    if (!args.sessionId) {
      throw new AgentError({
        code: ErrorCodes.CHECKPOINT_SAVE_FAIL,
        message: 'sessionId is required',
      });
    }
    const id = newCheckpointId();
    const createdAt = Date.now();

    // 写入文件快照（去重 + 跳过过大文件）
    const fileSnapshots: FileSnapshot[] = [];
    let totalBytes = 0;
    if (args.files && args.files.length > 0) {
      for (const f of args.files) {
        const snap = await this.storeFile(f);
        fileSnapshots.push(snap);
        if (!snap.skipped && !snap.wasDeleted) totalBytes += snap.sizeBytes;
      }
    }

    const checkpoint: Checkpoint = {
      id,
      sessionId: args.sessionId,
      createdAt,
      ...(args.label !== undefined ? { label: args.label } : {}),
      messageCount: args.messages.length,
      fileCount: fileSnapshots.length,
      totalBytes,
      messages: args.messages,
      fileSnapshots,
    };

    const sessionDir = this.getSessionDir(args.sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    try {
      await fs.writeFile(
        path.join(sessionDir, `${id}.json`),
        JSON.stringify(checkpoint),
        'utf-8',
      );
    } catch (e) {
      throw new AgentError({
        code: ErrorCodes.CHECKPOINT_SAVE_FAIL,
        message: `写入 checkpoint 失败: ${(e as Error).message}`,
        cause: e,
      });
    }

    // 更新 index.json（append meta 条目）
    const meta: CheckpointMeta = {
      id: checkpoint.id,
      sessionId: checkpoint.sessionId,
      createdAt: checkpoint.createdAt,
      ...(checkpoint.label !== undefined ? { label: checkpoint.label } : {}),
      messageCount: checkpoint.messageCount,
      fileCount: checkpoint.fileCount,
      totalBytes: checkpoint.totalBytes,
    };
    await this.appendIndex(args.sessionId, meta);

    // 裁剪
    await this.prune(args.sessionId, this.maxPerSession).catch((e) => {
      log.warn({ err: String(e) }, 'prune after create failed');
    });

    return checkpoint;
  }

  async list(sessionId: string): Promise<CheckpointMeta[]> {
    return this.readIndex(sessionId);
  }

  async get(id: string, sessionId: string): Promise<Checkpoint | undefined> {
    const file = path.join(this.getSessionDir(sessionId), `${id}.json`);
    if (!existsSync(file)) return undefined;
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return undefined;
      return parsed as Checkpoint;
    } catch (e) {
      throw new AgentError({
        code: ErrorCodes.CHECKPOINT_RESTORE_FAIL,
        message: `读取 checkpoint 失败: ${(e as Error).message}`,
        cause: e,
      });
    }
  }

  /**
   * W10.2 · 回滚前预检查冲突（DESIGN §M15.6）。
   * 对比当前磁盘文件与 checkpoint 内容 hash：
   *   - wasDeleted=true + 当前存在 → created_by_user
   *   - wasDeleted=false + 当前不存在 → deleted_by_user
   *   - hash 不一致 → modified_by_user
   *   - skipped=true 跳过（不能 revert也无冲突语义）
   */
  async precheckRevert(id: string, sessionId: string): Promise<RevertPrecheck> {
    const cp = await this.get(id, sessionId);
    if (!cp) {
      throw new AgentError({
        code: ErrorCodes.CHECKPOINT_RESTORE_FAIL,
        message: `checkpoint not found: ${id}`,
      });
    }
    const conflicts: RevertConflict[] = [];
    for (const snap of cp.fileSnapshots) {
      if (snap.skipped) continue;
      const abs = this.resolveSafe(snap.relPath);
      if (!abs) continue;
      const exists = existsSync(abs);
      if (snap.wasDeleted) {
        if (exists) {
          let actualHash: string | undefined;
          try {
            const buf = await fs.readFile(abs);
            actualHash = createHash('sha256').update(buf).digest('hex');
          } catch {
            /* ignore */
          }
          conflicts.push({
            relPath: snap.relPath,
            reason: 'created_by_user',
            expectedHash: '',
            ...(actualHash ? { actualHash } : {}),
          });
        }
        continue;
      }
      if (!exists) {
        conflicts.push({
          relPath: snap.relPath,
          reason: 'deleted_by_user',
          expectedHash: snap.contentHash,
        });
        continue;
      }
      try {
        const buf = await fs.readFile(abs);
        const actualHash = createHash('sha256').update(buf).digest('hex');
        if (actualHash !== snap.contentHash) {
          conflicts.push({
            relPath: snap.relPath,
            reason: 'modified_by_user',
            expectedHash: snap.contentHash,
            actualHash,
          });
        }
      } catch (e) {
        log.warn({ err: String(e), relPath: snap.relPath }, 'precheckRevert read failed');
      }
    }
    return { conflicts };
  }

  /**
   * 恢复指定 checkpoint 到工作区。
   * - 无条件恢复文件（wasDeleted 则删除；skipped 记入 filesSkipped）
   * - 返回 messages 供调用方注入到 TaskLoop/SessionStore
   */
  async revert(args: {
    id: string;
    sessionId: string;
    /** 是否应用文件快照（默认 true） */
    applyFiles?: boolean;
    /**
     * W10.2 · 冲突处理策略：
     * - 'overwrite'（默认，保持向后兼容）：无论是否冲突都覆盖。
     * - 'skip'：冲突的文件保留用户当前版本，计入 conflicts 返回。
     * - 'abort'：有任何冲突则报错，不恢复任何文件。
     */
    onConflict?: 'overwrite' | 'skip' | 'abort';
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
    // W10.2 · 先预检查冲突（abort/skip 策略需要，overwrite 也记录供UI提示）
    let prechecked: RevertPrecheck | undefined;
    if (args.applyFiles !== false) {
      prechecked = await this.precheckRevert(args.id, args.sessionId).catch(() => undefined);
      if (strategy === 'abort' && prechecked && prechecked.conflicts.length > 0) {
        throw new AgentError({
          code: ErrorCodes.CHECKPOINT_RESTORE_FAIL,
          message: `回滚中止：${prechecked.conflicts.length} 个文件在 checkpoint 后被手动修改`,
        });
      }
    }
    const conflictSet = new Set<string>(
      prechecked?.conflicts.map((c) => c.relPath) ?? [],
    );
    if (args.applyFiles !== false) {
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
        // skip 策略：冲突文件保留用户版本
        if (strategy === 'skip' && conflictSet.has(snap.relPath)) {
          filesSkipped++;
          continue;
        }
        if (snap.wasDeleted) {
          // 文件在快照时刻不存在 → 删除（若当前存在）
          try {
            if (existsSync(abs)) await fs.rm(abs, { force: true });
            filesDeleted++;
          } catch (e) {
            log.warn({ err: String(e), relPath: snap.relPath }, 'revert delete failed');
            filesSkipped++;
          }
        } else {
          // 从内容池读出并覆盖写回
          const pool = this.getFilesPoolPath(snap.contentHash);
          try {
            const content = await fs.readFile(pool, 'utf-8');
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.writeFile(abs, content, 'utf-8');
            filesApplied++;
          } catch (e) {
            log.warn({ err: String(e), relPath: snap.relPath }, 'revert apply failed');
            filesSkipped++;
          }
        }
      }
    }

    return {
      messages: cp.messages,
      filesApplied,
      filesDeleted,
      filesSkipped,
      ...(prechecked && prechecked.conflicts.length > 0
        ? { conflicts: prechecked.conflicts }
        : {}),
    };
  }

  /**
   * 定向删除某个 checkpoint：移除 `<sessionId>/<id>.json` 并在 index.json 中剔除。
   * - 不回收全局文件池（可能被其他 checkpoint 引用，交给未来 GC）
   * - 找不到则返回 false（不抛错）
   */
  async delete(id: string, sessionId: string): Promise<boolean> {
    const all = await this.readIndex(sessionId);
    const next = all.filter((m) => m.id !== id);
    const changed = next.length !== all.length;
    const file = path.join(this.getSessionDir(sessionId), `${id}.json`);
    try {
      if (existsSync(file)) await fs.rm(file, { force: true });
    } catch (e) {
      log.warn({ err: String(e), id }, 'delete checkpoint file failed; continue index update');
    }
    if (changed) {
      await this.writeIndex(sessionId, next);
    }
    return changed;
  }

  /**
   * W10.4 · 按时间维度 GC（DESIGN §M15.7）。
   * 删除老于 `olderThanDays` 天的所有 session 的 checkpoint（跨 session）；
   * 然后执行文件池孤儿回收（未被任何活跃 checkpoint 引用的 hash）。
   * 返回 { removedCheckpoints, removedPoolEntries }。
   */
  async gcOlderThan(
    olderThanDays: number,
    now: number = Date.now(),
  ): Promise<{ removedCheckpoints: number; removedPoolEntries: number }> {
    if (olderThanDays <= 0) {
      return { removedCheckpoints: 0, removedPoolEntries: 0 };
    }
    const cutoff = now - olderThanDays * 24 * 60 * 60 * 1000;
    const rootDir = path.join(this.workspaceRoot, ROOT_DIR);
    if (!existsSync(rootDir)) {
      return { removedCheckpoints: 0, removedPoolEntries: 0 };
    }
    let entries: string[] = [];
    try {
      entries = await fs.readdir(rootDir);
    } catch {
      return { removedCheckpoints: 0, removedPoolEntries: 0 };
    }
    let removedCheckpoints = 0;
    for (const name of entries) {
      if (name === FILES_DIR) continue;
      const sessionDir = path.join(rootDir, name);
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(sessionDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const sessionId = name;
      const all = await this.readIndex(sessionId);
      const survivors = all.filter((m) => m.createdAt >= cutoff);
      const victims = all.filter((m) => m.createdAt < cutoff);
      for (const v of victims) {
        const file = path.join(sessionDir, `${v.id}.json`);
        try {
          if (existsSync(file)) await fs.rm(file, { force: true });
          removedCheckpoints++;
        } catch (e) {
          log.warn({ err: String(e), id: v.id }, 'gcOlderThan remove cp failed');
        }
      }
      if (victims.length > 0) {
        await this.writeIndex(sessionId, survivors);
      }
    }
    const removedPoolEntries = await this.gcOrphanPoolFiles().catch(() => 0);
    return { removedCheckpoints, removedPoolEntries };
  }

  /**
   * 文件池孤儿回收：扫描所有 session 的所有 checkpoint，收集被引用的 hash
   * 集合；与 files/ 目录下的实际文件差集即为孤儿文件。
   * 返回删除的孤儿数量。
   */
  async gcOrphanPoolFiles(): Promise<number> {
    const filesDir = path.join(this.workspaceRoot, ROOT_DIR, FILES_DIR);
    if (!existsSync(filesDir)) return 0;
    const rootDir = path.join(this.workspaceRoot, ROOT_DIR);
    const referenced = new Set<string>();
    let sessionDirs: string[] = [];
    try {
      sessionDirs = await fs.readdir(rootDir);
    } catch {
      return 0;
    }
    for (const name of sessionDirs) {
      if (name === FILES_DIR) continue;
      const sessionDir = path.join(rootDir, name);
      try {
        const stat = await fs.stat(sessionDir);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      const metas = await this.readIndex(name);
      for (const meta of metas) {
        const cp = await this.get(meta.id, name).catch(() => undefined);
        if (!cp) continue;
        for (const snap of cp.fileSnapshots) {
          if (snap.contentHash) referenced.add(snap.contentHash);
        }
      }
    }
    let poolFiles: string[] = [];
    try {
      poolFiles = await fs.readdir(filesDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const h of poolFiles) {
      if (referenced.has(h)) continue;
      try {
        await fs.rm(path.join(filesDir, h), { force: true });
        removed++;
      } catch (e) {
        log.warn({ err: String(e), hash: h }, 'gcOrphanPoolFiles rm failed');
      }
    }
    return removed;
  }

  async prune(sessionId: string, maxCount: number): Promise<number> {
    if (maxCount <= 0) return 0;
    const all = await this.readIndex(sessionId);
    if (all.length <= maxCount) return 0;
    // 按 createdAt 升序：旧的在前，淘汰前 (all.length - maxCount) 条
    const sorted = [...all].sort((a, b) => a.createdAt - b.createdAt);
    const victims = sorted.slice(0, sorted.length - maxCount);
    const survivors = sorted.slice(sorted.length - maxCount);
    let removed = 0;
    for (const v of victims) {
      const file = path.join(this.getSessionDir(sessionId), `${v.id}.json`);
      try {
        if (existsSync(file)) await fs.rm(file, { force: true });
        removed++;
      } catch (e) {
        log.warn({ err: String(e), id: v.id }, 'prune file remove failed');
      }
    }
    await this.writeIndex(sessionId, survivors);
    return removed;
  }

  // ─────────── 内部：文件池 / 索引 / 路径 ───────────

  private async storeFile(input: FileSnapshotInput): Promise<FileSnapshot> {
    if (input.content === null) {
      return {
        relPath: input.relPath,
        contentHash: '',
        sizeBytes: 0,
        wasDeleted: true,
      };
    }
    const buf = Buffer.from(input.content, 'utf-8');
    const sizeBytes = buf.byteLength;
    if (sizeBytes > this.maxFileBytes) {
      return {
        relPath: input.relPath,
        contentHash: '',
        sizeBytes,
        wasDeleted: false,
        skipped: true,
      };
    }
    const hash = createHash('sha256').update(buf).digest('hex');
    const poolPath = this.getFilesPoolPath(hash);
    await fs.mkdir(path.dirname(poolPath), { recursive: true });
    // 去重：已存在则跳过写
    if (!existsSync(poolPath)) {
      try {
        await fs.writeFile(poolPath, buf);
      } catch (e) {
        throw new AgentError({
          code: ErrorCodes.CHECKPOINT_SAVE_FAIL,
          message: `写入文件池失败: ${(e as Error).message}`,
          cause: e,
        });
      }
    }
    return {
      relPath: input.relPath,
      contentHash: hash,
      sizeBytes,
      wasDeleted: false,
    };
  }

  private async appendIndex(sessionId: string, meta: CheckpointMeta): Promise<void> {
    const all = await this.readIndex(sessionId);
    all.push(meta);
    await this.writeIndex(sessionId, all);
  }

  private async readIndex(sessionId: string): Promise<CheckpointMeta[]> {
    const file = path.join(this.getSessionDir(sessionId), INDEX_FILE);
    if (!existsSync(file)) return [];
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.entries)) {
        return parsed.entries as CheckpointMeta[];
      }
      return [];
    } catch (e) {
      log.warn({ err: String(e), sessionId }, 'readIndex failed; returning empty');
      return [];
    }
  }

  private async writeIndex(sessionId: string, entries: CheckpointMeta[]): Promise<void> {
    const dir = this.getSessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, INDEX_FILE);
    try {
      await fs.writeFile(file, JSON.stringify({ entries }, null, 2), 'utf-8');
    } catch (e) {
      throw new AgentError({
        code: ErrorCodes.CHECKPOINT_SAVE_FAIL,
        message: `写入 checkpoint 索引失败: ${(e as Error).message}`,
        cause: e,
      });
    }
  }

  private getSessionDir(sessionId: string): string {
    return path.join(this.workspaceRoot, ROOT_DIR, sanitizeId(sessionId));
  }

  private getFilesPoolPath(hash: string): string {
    return path.join(this.workspaceRoot, ROOT_DIR, FILES_DIR, hash);
  }

  /**
   * 防止路径穿越：relPath 不能以 / 开头、不能出现 ..
   * 返回 undefined 视为非法路径应跳过。
   */
  private resolveSafe(relPath: string): string | undefined {
    if (!relPath || relPath.startsWith('/') || relPath.startsWith('\\')) return undefined;
    const parts = relPath.replace(/\\/g, '/').split('/');
    if (parts.some((p) => p === '..' || p === '.')) return undefined;
    return path.resolve(this.workspaceRoot, ...parts);
  }
}

// ─────────── helpers ───────────

function newCheckpointId(): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `cp-${Date.now().toString(36)}-${rnd}`;
}

function sanitizeId(id: string): string {
  // 仅保留字母数字 / 短横线 / 下划线；其他替换为 _
  return id.replace(/[^A-Za-z0-9_\-]/g, '_');
}

