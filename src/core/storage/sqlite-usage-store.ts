/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-P1-16 · SqliteUsageStore —— 基于 SQLite 的 IUsageRecord 持久化（DESIGN §M16.6）
 *
 * 替换原 `UsageJsonlStore`，保持 public API 兼容：
 *   append / readAll / read / gc / clear / getFilePath
 *
 * 表结构见 `sqlite-db.ts`：
 *   usage(id AUTOINCREMENT, ts, provider, model, operation,
 *         promptTokens, completionTokens, cachedTokens, cost, currency,
 *         sessionId, turnId)
 *
 * 行为对齐旧实现：
 * - append：失败吞异常
 * - readAll：无数据返回空数组；ts 升序
 * - read(filter)：所有过滤条件在 SQL 层应用（since / until / provider / operation / sessionId）
 * - gc(cutoffMs)：DELETE ts < cutoffMs；返回删除数
 * - clear()：DELETE all
 * - getFilePath()：返回 DB 文件路径（替代原 JSONL 路径，便于 UI 显示来源）
 */

import type {
  CostSink,
  IUsageRecord,
  UsageFilter,
} from '../cost/types.js';
import type { SqliteDatabaseLike } from './sqlite-db.js';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('sqlite.usage-store');

export interface SqliteUsageStoreOptions {
  db: SqliteDatabaseLike;
  /** 数据库文件路径（仅用于 getFilePath() 显示，不用于 I/O） */
  dbPath: string;
}

export class SqliteUsageStore implements CostSink {
  private readonly db: SqliteDatabaseLike;
  private readonly dbPath: string;

  constructor(opts: SqliteUsageStoreOptions) {
    this.db = opts.db;
    this.dbPath = opts.dbPath;
  }

  getFilePath(): string {
    return this.dbPath;
  }

  append(record: IUsageRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO usage(
             ts, provider, model, operation,
             promptTokens, completionTokens, cachedTokens,
             cost, currency, sessionId, turnId
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.ts,
          record.provider,
          record.model ?? null,
          record.operation,
          record.promptTokens ?? null,
          record.completionTokens ?? null,
          record.cachedTokens ?? null,
          record.cost,
          record.currency,
          record.sessionId ?? null,
          record.turnId ?? null,
        );
    } catch (e) {
      log.warn({ err: String(e) }, 'usage append failed; swallow');
    }
  }

  async readAll(): Promise<IUsageRecord[]> {
    return this.read({});
  }

  async read(filter: UsageFilter = {}): Promise<IUsageRecord[]> {
    try {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.since !== undefined) {
        where.push('ts >= ?');
        params.push(filter.since);
      }
      if (filter.until !== undefined) {
        where.push('ts < ?');
        params.push(filter.until);
      }
      if (filter.provider !== undefined) {
        where.push('provider = ?');
        params.push(filter.provider);
      }
      if (filter.operation !== undefined) {
        where.push('operation = ?');
        params.push(filter.operation);
      }
      if (filter.sessionId !== undefined) {
        where.push('sessionId = ?');
        params.push(filter.sessionId);
      }
      const whereClause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
      const rows = this.db
        .prepare(
          `SELECT ts, provider, model, operation,
                  promptTokens, completionTokens, cachedTokens,
                  cost, currency, sessionId, turnId
           FROM usage${whereClause}
           ORDER BY ts ASC`,
        )
        .all(...params) as Array<Record<string, unknown>>;
      return rows.map(rowToRecord);
    } catch (e) {
      log.warn({ err: String(e) }, 'usage read failed; fallback []');
      return [];
    }
  }

  async gc(cutoffMs: number): Promise<number> {
    try {
      const res = this.db.prepare('DELETE FROM usage WHERE ts < ?').run(cutoffMs);
      return res.changes;
    } catch (e) {
      log.warn({ err: String(e) }, 'usage gc failed');
      return 0;
    }
  }

  async clear(): Promise<void> {
    try {
      this.db.exec('DELETE FROM usage');
    } catch (e) {
      log.warn({ err: String(e) }, 'usage clear failed');
    }
  }
}

function rowToRecord(row: Record<string, unknown>): IUsageRecord {
  const rec: IUsageRecord = {
    ts: Number(row.ts ?? 0),
    provider: String(row.provider ?? ''),
    operation: String(row.operation ?? 'chat') as IUsageRecord['operation'],
    cost: Number(row.cost ?? 0),
    currency: (row.currency === 'USD' ? 'USD' : 'CNY') as IUsageRecord['currency'],
  };
  if (row.model != null) rec.model = String(row.model);
  if (row.promptTokens != null) rec.promptTokens = Number(row.promptTokens);
  if (row.completionTokens != null) rec.completionTokens = Number(row.completionTokens);
  if (row.cachedTokens != null) rec.cachedTokens = Number(row.cachedTokens);
  if (row.sessionId != null) rec.sessionId = String(row.sessionId);
  if (row.turnId != null) rec.turnId = String(row.turnId);
  return rec;
}
