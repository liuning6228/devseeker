/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Checkpoints 类型
 *
 * 来源：DESIGN §M15 Checkpoint / Rollback
 *
 * 模型：
 * - Checkpoint 是某时刻对话历史 + 已追踪文件内容的快照。
 * - 每个工作区有一个全局文件池（.dualmind/checkpoints/files/<sha256>），跨 session 去重。
 * - 每个 session 独立目录保存其 checkpoint 列表（.dualmind/checkpoints/<sessionId>/）。
 * - MVP：文件内容以 UTF-8 文本处理；大于 DEFAULT_MAX_FILE_BYTES 的文件跳过（仅记 skipped 标志）。
 */

import type { Message } from '../../providers/types.js';

export interface FileSnapshotInput {
  /** 相对 workspaceRoot 的路径（使用 POSIX / 分隔） */
  relPath: string;
  /**
   * 文件内容：
   * - string → 作为 UTF-8 文本存入
   * - null → 代表此刻文件不存在（回滚时应删除）
   */
  content: string | null;
}

export interface FileSnapshot {
  relPath: string;
  /** sha256 hex；wasDeleted=true 时固定为空串 */
  contentHash: string;
  /** 原文件字节数；wasDeleted=true 时为 0；skipped=true 时为原大小 */
  sizeBytes: number;
  wasDeleted: boolean;
  /** 超出大小阈值被跳过；既不写池也不能 revert */
  skipped?: boolean;
}

export interface CheckpointMeta {
  id: string;
  sessionId: string;
  createdAt: number;
  label?: string;
  messageCount: number;
  fileCount: number;
  /** 记录的文件总字节数（不含 skipped） */
  totalBytes: number;
}

export interface Checkpoint extends CheckpointMeta {
  messages: Message[];
  fileSnapshots: FileSnapshot[];
}

export interface CreateCheckpointArgs {
  sessionId: string;
  messages: Message[];
  files?: FileSnapshotInput[];
  label?: string;
}

export interface RevertResult {
  messages: Message[];
  filesApplied: number;
  filesDeleted: number;
  filesSkipped: number;
  /** W10.2 · 冲突文件列表（checkpoint 创建后用户手动改过的文件） */
  conflicts?: RevertConflict[];
}

/** W10.2 · 回滚冲突（DESIGN §M15.6） */
export interface RevertConflict {
  relPath: string;
  /** 冲突原因 */
  reason: 'modified_by_user' | 'created_by_user' | 'deleted_by_user';
  /** checkpoint 时的 hash（wasDeleted 为空串） */
  expectedHash: string;
  /** 当前磁盘 hash（不存在为 undefined） */
  actualHash?: string;
}

/** W10.2 · 预检查结果：revert 前可调 precheck 拿冲突清单 */
export interface RevertPrecheck {
  conflicts: RevertConflict[];
}

export interface CheckpointStoreOptions {
  workspaceRoot: string;
  /** 单个文件最大字节数；超过则跳过（不阻塞 checkpoint 创建） */
  maxFileBytes?: number;
  /** 每个 session 保留的 checkpoint 上限；超出则按 createdAt 升序 prune */
  maxPerSession?: number;
}

/** 默认单文件上限 1 MiB */
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
/** 默认每 session 保留 50 个 checkpoint */
export const DEFAULT_MAX_PER_SESSION = 50;

