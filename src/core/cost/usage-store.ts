/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * UsageJsonlStore —— 基于 JSONL 的 IUsageRecord 持久化（DESIGN §M16.6 MVP 替代）
 *
 * 存储格式：默认 `~/.dualmind/usage.jsonl`
 * - 每行一条 IUsageRecord（UTF-8 JSON.stringify）
 * - append 追加写入，永不锁文件之外做复杂操作
 * - 损坏行（解析失败）在 readAll/readSince 中被跳过并计入 warning log
 *
 * 设计取舍：
 * - SQLite 留给 W8+（依赖 better-sqlite3 native 模块）
 * - JSONL 天然对日志友好、故障容忍、易导出
 * - gc 通过重写文件实现（保留 ts >= cutoff 的行）
 *
 * 线程/并发：
 * - Node 单线程进程内 append 串行化（fs.appendFile 内部排队即可）
 * - 多进程并发写需留意：MVP 认为仅 VS Code 插件单进程访问
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLogger } from '../../infra/logger.js';
import type { CostSink, IUsageRecord, UsageFilter } from './types.js';

const log = getLogger('cost.usage-store');

export interface UsageJsonlStoreOptions {
  /** 完整 jsonl 文件路径；默认 `~/.dualmind/usage.jsonl` */
  filePath?: string;
}

export class UsageJsonlStore implements CostSink {
  private readonly filePath: string;

  constructor(opts: UsageJsonlStoreOptions = {}) {
    this.filePath = opts.filePath ?? path.join(os.homedir(), '.dualmind', 'usage.jsonl');
  }

  getFilePath(): string {
    return this.filePath;
  }

  /** 追加一条记录。失败吞异常不阻塞主流程。 */
  async append(record: IUsageRecord): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (e) {
      log.warn({ err: String(e) }, 'usage append failed; swallow');
    }
  }

  /** 读取全部记录。文件不存在返回空数组。损坏行跳过。 */
  async readAll(): Promise<IUsageRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      log.warn({ err: String(e) }, 'usage readAll failed');
      return [];
    }
    const out: IUsageRecord[] = [];
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const r = JSON.parse(trimmed) as IUsageRecord;
        if (isValidRecord(r)) out.push(r);
      } catch {
        // 跳过损坏行
      }
    }
    return out;
  }

  /** 按 filter 过滤读取 */
  async read(filter: UsageFilter = {}): Promise<IUsageRecord[]> {
    const all = await this.readAll();
    return all.filter((r) => matches(r, filter));
  }

  /**
   * 垃圾回收：保留 ts >= cutoffMs 的记录，其余删除。
   * 返回删除的条数。
   */
  async gc(cutoffMs: number): Promise<number> {
    const all = await this.readAll();
    const kept = all.filter((r) => r.ts >= cutoffMs);
    if (kept.length === all.length) return 0;
    const next = kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : '');
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, next, 'utf-8');
    } catch (e) {
      log.warn({ err: String(e) }, 'usage gc write failed');
      return 0;
    }
    return all.length - kept.length;
  }

  /** 清空文件（仅测试 / 用户"重置今日"用） */
  async clear(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, '', 'utf-8');
    } catch (e) {
      log.warn({ err: String(e) }, 'usage clear failed');
    }
  }
}

// ─────────── helpers ───────────

function isValidRecord(r: unknown): r is IUsageRecord {
  if (!r || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  return (
    typeof x.ts === 'number' &&
    typeof x.provider === 'string' &&
    typeof x.operation === 'string' &&
    typeof x.cost === 'number' &&
    (x.currency === 'CNY' || x.currency === 'USD')
  );
}

function matches(r: IUsageRecord, f: UsageFilter): boolean {
  if (f.since !== undefined && r.ts < f.since) return false;
  if (f.until !== undefined && r.ts >= f.until) return false;
  if (f.provider !== undefined && r.provider !== f.provider) return false;
  if (f.operation !== undefined && r.operation !== f.operation) return false;
  if (f.sessionId !== undefined && r.sessionId !== f.sessionId) return false;
  return true;
}

/** 当日零点 ts（本地时区） */
export function todayStartMs(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
