/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-P1-16 · SQLite 一次性迁移器（DESIGN §M16.6）
 *
 * 触发时机：
 * - Extension/Panel 构造时调用 `runLegacyMigrationIfNeeded(db, ctx)`
 * - 通过 meta 表 `legacy.migrated.v1` 标记防止重复迁移
 *
 * 迁移源（任一缺失即跳过对应子迁移）：
 * - legacyMemento：原 SessionStore 的 workspaceState（key=`devSeeker.sessions.v1` / `devSeeker.totalCost.v1`）
 * - legacyJsonlPath：原 UsageJsonlStore 的 JSONL 文件路径
 *
 * 语义（彻底迁移策略 · 用户选项）：
 * - 导入完成后在 meta 打标记
 * - legacyJsonlPath 会被 *重命名* 为 `.migrated-YYYYMMDD-HHmm` 以避免重复读入 / 意外双写
 * - legacyMemento 的两个 key 不主动清空，防止用户回滚扩展版本后丢数据（SQLite 接管后读不到）
 *
 * 幂等 / 失败策略：
 * - 每个子迁移独立 try/catch，失败只 log.warn 不中断
 * - 只要任一子迁移成功写入，就打标记避免下次重复
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MementoLike, StoredSession } from '../session/store.js';
import type { IUsageRecord } from '../cost/types.js';
import type { ProviderCost } from '../cost/tracker.js';
import {
  type SqliteDatabaseLike,
  getMetaString,
  setMetaString,
} from './sqlite-db.js';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('sqlite.migrator');

const MIGRATED_META_KEY = 'legacy.migrated.v1';
const LEGACY_KEY_SESSIONS = 'devSeeker.sessions.v1';
const LEGACY_KEY_TOTAL_COST = 'devSeeker.totalCost.v1';

export interface MigrationStats {
  /** 是否真正执行了迁移（false 表示已标记 / 被跳过） */
  performed: boolean;
  sessionsImported: number;
  totalCostImported: number;
  usageImported: number;
  usageSkippedInvalid: number;
  legacyJsonlRenamedTo?: string;
  errors: string[];
}

export interface RunLegacyMigrationOptions {
  db: SqliteDatabaseLike;
  legacyMemento?: MementoLike;
  legacyJsonlPath?: string;
  /** 测试注入：覆盖重命名目标文件名后缀；默认按当前时间戳 */
  renameStamp?: string;
  /** 测试注入：强制重跑（忽略已标记） */
  force?: boolean;
}

export async function runLegacyMigrationIfNeeded(
  opts: RunLegacyMigrationOptions,
): Promise<MigrationStats> {
  const stats: MigrationStats = {
    performed: false,
    sessionsImported: 0,
    totalCostImported: 0,
    usageImported: 0,
    usageSkippedInvalid: 0,
    errors: [],
  };
  try {
    if (!opts.force && getMetaString(opts.db, MIGRATED_META_KEY) === 'done') {
      return stats;
    }
  } catch (e) {
    // meta 表不存在 / 其他异常：视为未迁移，继续
    stats.errors.push(`meta-check: ${(e as Error).message}`);
  }

  // ─── Sessions + totalCost 从 Memento 迁移 ───
  if (opts.legacyMemento) {
    try {
      const sessions = opts.legacyMemento.get<StoredSession[]>(LEGACY_KEY_SESSIONS, []);
      if (Array.isArray(sessions) && sessions.length > 0) {
        const stmt = opts.db.prepare(
          `INSERT OR IGNORE INTO sessions(id, createdAt, updatedAt, title, messages, sessionCost)
           VALUES(?, ?, ?, ?, ?, ?)`,
        );
        for (const s of sessions) {
          if (!s || typeof s.id !== 'string') continue;
          try {
            stmt.run(
              s.id,
              Number(s.createdAt ?? Date.now()),
              Number(s.updatedAt ?? Date.now()),
              String(s.title ?? ''),
              JSON.stringify(s.messages ?? []),
              JSON.stringify(s.sessionCost ?? []),
            );
            stats.sessionsImported += 1;
          } catch (e) {
            stats.errors.push(`session ${s.id}: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      stats.errors.push(`sessions-read: ${(e as Error).message}`);
    }

    try {
      const totalCost = opts.legacyMemento.get<ProviderCost[]>(LEGACY_KEY_TOTAL_COST, []);
      if (Array.isArray(totalCost) && totalCost.length > 0) {
        const stmt = opts.db.prepare(
          `INSERT OR IGNORE INTO total_cost(provider, data) VALUES(?, ?)`,
        );
        for (const c of totalCost) {
          if (!c) continue;
          const provider =
            typeof (c as unknown as { provider?: string }).provider === 'string'
              ? (c as unknown as { provider: string }).provider
              : JSON.stringify(c).slice(0, 40);
          try {
            stmt.run(provider, JSON.stringify(c));
            stats.totalCostImported += 1;
          } catch (e) {
            stats.errors.push(`totalCost ${provider}: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      stats.errors.push(`totalCost-read: ${(e as Error).message}`);
    }
  }

  // ─── Usage 从 JSONL 迁移 ───
  if (opts.legacyJsonlPath) {
    let raw: string | undefined;
    try {
      raw = await fs.readFile(opts.legacyJsonlPath, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        stats.errors.push(`usage-read: ${(e as Error).message}`);
      }
    }
    if (raw !== undefined && raw.trim().length > 0) {
      const stmt = opts.db.prepare(
        `INSERT INTO usage(
           ts, provider, model, operation,
           promptTokens, completionTokens, cachedTokens,
           cost, currency, sessionId, turnId
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec: IUsageRecord;
        try {
          rec = JSON.parse(trimmed) as IUsageRecord;
        } catch {
          stats.usageSkippedInvalid += 1;
          continue;
        }
        if (!isValidUsageRecord(rec)) {
          stats.usageSkippedInvalid += 1;
          continue;
        }
        try {
          stmt.run(
            rec.ts,
            rec.provider,
            rec.model ?? null,
            rec.operation,
            rec.promptTokens ?? null,
            rec.completionTokens ?? null,
            rec.cachedTokens ?? null,
            rec.cost,
            rec.currency,
            rec.sessionId ?? null,
            rec.turnId ?? null,
          );
          stats.usageImported += 1;
        } catch (e) {
          stats.errors.push(`usage-insert: ${(e as Error).message}`);
          stats.usageSkippedInvalid += 1;
        }
      }

      // 重命名旧 JSONL 防止二次读入
      try {
        const stamp = opts.renameStamp ?? stampNow();
        const dest = `${opts.legacyJsonlPath}.migrated-${stamp}`;
        await fs.rename(opts.legacyJsonlPath, dest);
        stats.legacyJsonlRenamedTo = dest;
      } catch (e) {
        stats.errors.push(`usage-rename: ${(e as Error).message}`);
      }
    }
  }

  // 打迁移标记（即使 0 条也打，避免下次重复尝试）
  try {
    setMetaString(opts.db, MIGRATED_META_KEY, 'done');
  } catch (e) {
    stats.errors.push(`set-meta: ${(e as Error).message}`);
  }

  stats.performed = true;
  log.info(
    {
      sessions: stats.sessionsImported,
      totalCost: stats.totalCostImported,
      usage: stats.usageImported,
      usageSkipped: stats.usageSkippedInvalid,
      errors: stats.errors.length,
    },
    'legacy migration done',
  );
  return stats;
}

function isValidUsageRecord(r: unknown): r is IUsageRecord {
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

function stampNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// Export helpers for tests
export const __INTERNAL__ = {
  MIGRATED_META_KEY,
  LEGACY_KEY_SESSIONS,
  LEGACY_KEY_TOTAL_COST,
};
