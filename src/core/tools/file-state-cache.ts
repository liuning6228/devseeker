/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * FileStateCache —— 追踪 read_file 工具读取的文件时间戳（§8.11.2）
 *
 * 职责：
 * - read_file 成功执行时，记录该文件的 mtimeMs + 时间戳
 * - search_replace/write_file 执行前查询缓存，比对当前 mtimeMs
 * - 写类工具成功后由 ToolRunner 统一调用 refreshFileStateCacheAfterWrite 刷新（修正自写误报）
 * - 默认 TTL = 30 秒（超过此时间 cache 条目自动过期，不触发冲突检测）
 *
 * 线程安全：单线程 VSCode Extension Host，无需锁。
 * 生命周期：随 TaskLoop 创建，TaskLoop 结束释放（非全局单例）。
 * 调用方通过 ToolContext 传入 Cache 实例；无 cache 时跳过冲突检测。
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

export interface FileStateCacheEntry {
  /** 文件绝对路径（作为 key） */
  filePath: string;
  /** read_file 成功时的 fs.stat.mtimeMs */
  recordedMtimeMs: number;
  /** 记录时间（Date.now()），用于过期判断 */
  recordedAt: number;
}

export class FileStateCache {
  private store = new Map<string, FileStateCacheEntry>();
  /** TTL ms，默认 30000 */
  private readonly ttlMs: number;

  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  /** read_file 成功后调用 */
  record(filePath: string, mtimeMs: number): void {
    this.store.set(filePath, {
      filePath,
      recordedMtimeMs: mtimeMs,
      recordedAt: Date.now(),
    });
  }

  /** 查询文件是否有缓存且未过期；返回缓存条目或 null */
  get(filePath: string): FileStateCacheEntry | null {
    const entry = this.store.get(filePath);
    if (!entry) return null;
    if (Date.now() - entry.recordedAt > this.ttlMs) {
      this.store.delete(filePath);
      return null;
    }
    return entry;
  }

  /** 清除某文件的缓存（写入成功后调用） */
  invalidate(filePath: string): void {
    this.store.delete(filePath);
  }

  /** 清除全部缓存（TaskLoop 结束时调用） */
  clear(): void {
    this.store.clear();
  }

  /** 测试用 */
  size(): number {
    return this.store.size;
  }
}

/**
 * 写类工具成功后刷新缓存（由 ToolRunner 统一调用，覆盖 search_replace/write_file/
 * append_file/delete_file 四条写路径）。
 *
 * 背景（线上 PATCH.CONFLICT 误报根因）：本类原文档要求“写入成功后调用 invalidate”，
 * 但全仓无任何调用点 → read_file 记录 M0 后，同一文件第二次编辑时磁盘 mtime
 * 已是 M1（agent 自己的上一次写入）→ 误报“文件已被外部修改”，模型被迫 read_file
 * 再重试，连续编辑时反复出现。
 *
 * 语义（优于单纯 invalidate）：
 * - 正常写入：记录写入后的新 mtime → 消除自写误报，同时保留此后对该文件的外部修改检测
 * - 删除/刷新失败：invalidate（宁可不检测，不可误报）
 */
export async function refreshFileStateCacheAfterWrite(
  cache: FileStateCache,
  filePath: string,
  opts?: { workspaceRoot?: string; removed?: boolean },
): Promise<void> {
  const abs = isAbsolute(filePath)
    ? filePath
    : resolvePath(opts?.workspaceRoot ?? process.cwd(), filePath);
  // realpath 对齐：read_file / search_replace 均以 safeRealpath 后的路径为 key
  let real = abs;
  try {
    real = await fs.realpath(abs);
  } catch {
    /* 删除场景 realpath 失败 → 用 abs 兜底 invalidate */
  }
  if (opts?.removed) {
    cache.invalidate(real);
    return;
  }
  try {
    const st = await fs.stat(real);
    cache.record(real, st.mtimeMs);
  } catch {
    // 文件不在（如被并发删除）→ 移除缓存，避免后续误判
    cache.invalidate(real);
  }
}
