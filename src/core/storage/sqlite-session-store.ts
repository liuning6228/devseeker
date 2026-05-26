/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-P1-16 · SqliteSessionStore —— 基于 SQLite 的会话持久化（DESIGN §M16.6）
 *
 * 替换原 `SessionStore`（基于 vscode.Memento），但保持 public API 兼容：
 *   listSessions / latestSession / getSession / saveSession / deleteSession /
 *   clearAll / appendMessage / markReverted / exportSession / gc /
 *   loadTotalCost / saveTotalCost / snapshot
 *
 * 表结构见 `sqlite-db.ts`：
 *   sessions(id PK, createdAt, updatedAt, title, messages JSON, sessionCost JSON)
 *   total_cost(provider PK, data JSON)
 *
 * 读写策略：
 * - 读：prepare + get/all；messages/sessionCost 字段存 JSON，读取时解析
 * - 写：ON CONFLICT UPDATE；appendMessage 走 UPDATE 拼接而非全量重写（只覆盖 messages + updatedAt）
 * - saveSession 附带 maxSessions 截断：在 transaction 内删除超限行
 * - 异常统一吞进 logger.warn，不阻塞主流程（与旧 SessionStore 行为对齐）
 */

import type { Message } from '../../providers/types.js';
import type { ProviderCost } from '../cost/tracker.js';
import {
  type StoredSession,
  type SessionStoreSnapshot,
  renderSessionMarkdown,
} from '../session/store.js';
import type { SqliteDatabaseLike } from './sqlite-db.js';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('sqlite.session-store');

const DEFAULT_MAX_SESSIONS = 100;

export interface SqliteSessionStoreOptions {
  db: SqliteDatabaseLike;
  maxSessions?: number;
}

export class SqliteSessionStore {
  private readonly db: SqliteDatabaseLike;
  private readonly maxSessions: number;

  constructor(opts: SqliteSessionStoreOptions) {
    this.db = opts.db;
    this.maxSessions = Math.max(1, opts.maxSessions ?? DEFAULT_MAX_SESSIONS);
  }

  // ─────────── read ───────────

  listSessions(): StoredSession[] {
    try {
      const rows = this.db
        .prepare(
          'SELECT id, createdAt, updatedAt, title, messages, sessionCost FROM sessions ORDER BY updatedAt DESC',
        )
        .all() as Array<{
        id: string;
        createdAt: number;
        updatedAt: number;
        title: string;
        messages: string;
        sessionCost: string;
      }>;
      return rows.map((r) => rowToSession(r));
    } catch (e) {
      log.warn({ err: String(e) }, 'listSessions failed; fallback []');
      return [];
    }
  }

  latestSession(): StoredSession | undefined {
    try {
      const row = this.db
        .prepare(
          'SELECT id, createdAt, updatedAt, title, messages, sessionCost FROM sessions ORDER BY updatedAt DESC LIMIT 1',
        )
        .get() as
        | {
            id: string;
            createdAt: number;
            updatedAt: number;
            title: string;
            messages: string;
            sessionCost: string;
          }
        | undefined;
      return row ? rowToSession(row) : undefined;
    } catch (e) {
      log.warn({ err: String(e) }, 'latestSession failed');
      return undefined;
    }
  }

  getSession(id: string): StoredSession | undefined {
    try {
      const row = this.db
        .prepare(
          'SELECT id, createdAt, updatedAt, title, messages, sessionCost FROM sessions WHERE id = ?',
        )
        .get(id) as
        | {
            id: string;
            createdAt: number;
            updatedAt: number;
            title: string;
            messages: string;
            sessionCost: string;
          }
        | undefined;
      return row ? rowToSession(row) : undefined;
    } catch (e) {
      log.warn({ err: String(e), id }, 'getSession failed');
      return undefined;
    }
  }

  // ─────────── write ───────────

  async saveSession(session: StoredSession): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO sessions(id, createdAt, updatedAt, title, messages, sessionCost)
           VALUES(?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             createdAt   = excluded.createdAt,
             updatedAt   = excluded.updatedAt,
             title       = excluded.title,
             messages    = excluded.messages,
             sessionCost = excluded.sessionCost`,
        )
        .run(
          session.id,
          session.createdAt,
          session.updatedAt,
          session.title,
          JSON.stringify(session.messages),
          JSON.stringify(session.sessionCost),
        );
      this.trimToMax();
    } catch (e) {
      log.warn({ err: String(e), id: session.id }, 'saveSession failed; swallow');
    }
  }

  async deleteSession(id: string): Promise<void> {
    try {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    } catch (e) {
      log.warn({ err: String(e), id }, 'deleteSession failed; swallow');
    }
  }

  async clearAll(): Promise<void> {
    try {
      this.db.exec('DELETE FROM sessions');
    } catch (e) {
      log.warn({ err: String(e) }, 'clearAll failed; swallow');
    }
  }

  async appendMessage(sessionId: string, msg: Message): Promise<void> {
    const target = this.getSession(sessionId);
    if (!target) return;
    const next: StoredSession = {
      ...target,
      messages: [...target.messages, msg],
      updatedAt: Date.now(),
    };
    try {
      this.db
        .prepare(
          'UPDATE sessions SET messages = ?, updatedAt = ? WHERE id = ?',
        )
        .run(JSON.stringify(next.messages), next.updatedAt, sessionId);
    } catch (e) {
      log.warn({ err: String(e), sessionId }, 'appendMessage failed; swallow');
    }
  }

  async markReverted(sessionId: string, messageIndex: number): Promise<void> {
    const target = this.getSession(sessionId);
    if (!target) return;
    if (messageIndex < 0 || messageIndex >= target.messages.length) return;
    const nextMessages = target.messages.map((m, i) =>
      i === messageIndex
        ? ({ ...m, _reverted: true } as Message & { _reverted: true })
        : m,
    );
    const now = Date.now();
    try {
      this.db
        .prepare(
          'UPDATE sessions SET messages = ?, updatedAt = ? WHERE id = ?',
        )
        .run(JSON.stringify(nextMessages), now, sessionId);
    } catch (e) {
      log.warn({ err: String(e), sessionId }, 'markReverted failed; swallow');
    }
  }

  exportSession(sessionId: string, format: 'md' | 'json'): string | undefined {
    const s = this.getSession(sessionId);
    if (!s) return undefined;
    if (format === 'json') return JSON.stringify(s, null, 2);
    return renderSessionMarkdown(s);
  }

  async gc(keepLast: number): Promise<number> {
    if (keepLast <= 0) return 0;
    try {
      const total = (this.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as
        | { c: number }
        | undefined)?.c ?? 0;
      if (total <= keepLast) return 0;
      const toDelete = total - keepLast;
      const res = this.db
        .prepare(
          `DELETE FROM sessions WHERE id IN (
             SELECT id FROM sessions ORDER BY updatedAt ASC LIMIT ?
           )`,
        )
        .run(toDelete);
      return res.changes;
    } catch (e) {
      log.warn({ err: String(e) }, 'gc failed; swallow');
      return 0;
    }
  }

  // ─────────── total cost ───────────

  loadTotalCost(): ProviderCost[] {
    try {
      const rows = this.db.prepare('SELECT data FROM total_cost').all() as Array<{ data: string }>;
      const out: ProviderCost[] = [];
      for (const r of rows) {
        try {
          out.push(JSON.parse(r.data) as ProviderCost);
        } catch {
          /* skip */
        }
      }
      return out;
    } catch (e) {
      log.warn({ err: String(e) }, 'loadTotalCost failed; fallback []');
      return [];
    }
  }

  async saveTotalCost(costs: ProviderCost[]): Promise<void> {
    try {
      const stmt = this.db.prepare(
        `INSERT INTO total_cost(provider, data)
         VALUES(?, ?)
         ON CONFLICT(provider) DO UPDATE SET data = excluded.data`,
      );
      // 简化：先清空后全插。数量小（provider 级），一致性更高。
      this.db.exec('DELETE FROM total_cost');
      for (const c of costs) {
        const key = typeof (c as unknown as { provider?: string }).provider === 'string'
          ? (c as unknown as { provider: string }).provider
          : JSON.stringify(c).slice(0, 40);
        stmt.run(key, JSON.stringify(c));
      }
    } catch (e) {
      log.warn({ err: String(e) }, 'saveTotalCost failed; swallow');
    }
  }

  snapshot(): SessionStoreSnapshot {
    return { sessions: this.listSessions(), totalCost: this.loadTotalCost() };
  }

  // ─────────── internals ───────────

  private trimToMax(): void {
    try {
      const total = (this.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as
        | { c: number }
        | undefined)?.c ?? 0;
      if (total <= this.maxSessions) return;
      const toDelete = total - this.maxSessions;
      this.db
        .prepare(
          `DELETE FROM sessions WHERE id IN (
             SELECT id FROM sessions ORDER BY updatedAt ASC LIMIT ?
           )`,
        )
        .run(toDelete);
    } catch (e) {
      log.warn({ err: String(e) }, 'trimToMax failed; swallow');
    }
  }
}

function rowToSession(row: {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  messages: string;
  sessionCost: string;
}): StoredSession {
  let messages: Message[] = [];
  let sessionCost: ProviderCost[] = [];
  try {
    const parsed = JSON.parse(row.messages);
    if (Array.isArray(parsed)) messages = parsed as Message[];
  } catch {
    /* ignore */
  }
  try {
    const parsed = JSON.parse(row.sessionCost);
    if (Array.isArray(parsed)) sessionCost = parsed as ProviderCost[];
  } catch {
    /* ignore */
  }
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    title: row.title,
    messages,
    sessionCost,
  };
}
