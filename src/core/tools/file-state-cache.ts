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
 * - 默认 TTL = 30 秒（超过此时间 cache 条目自动过期，不触发冲突检测）
 *
 * 线程安全：单线程 VSCode Extension Host，无需锁。
 * 生命周期：随 TaskLoop 创建，TaskLoop 结束释放（非全局单例）。
 * 调用方通过 ToolContext 传入 Cache 实例；无 cache 时跳过冲突检测。
 */

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
