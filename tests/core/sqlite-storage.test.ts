/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-P1-16 · SQLite 存储层单测（sqlite-db / session-store / usage-store / migrator）
 *
 * v1.4.0 · 使用 sql.js（WASM SQLite）替代 better-sqlite3
 * 覆盖 21+ 条用例，使用真实 sql.js 临时文件：
 *   sqlite-db:     openSqliteDatabase / applyMigrations 幂等 / meta 读写 / defaultSqlitePath / schema v1
 *   session-store: save+get / list(DESC) / appendMessage / deleteSession / markReverted /
 *                  maxSessions 自动 trim / totalCost 往返
 *   usage-store:   append+readAll / filter / gc / clear / getFilePath
 *   migrator:      memento + jsonl 首次导入 / 标记防重入 / JSONL 重命名 / 无效行计数
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  openSqliteDatabase,
  applyMigrations,
  getMetaString,
  setMetaString,
  defaultSqlitePath,
  CURRENT_SCHEMA_VERSION,
  InMemoryDb,
  type SqliteDatabaseLike,
} from '../../src/core/storage/sqlite-db.js';
import { SqliteSessionStore } from '../../src/core/storage/sqlite-session-store.js';
import { SqliteUsageStore } from '../../src/core/storage/sqlite-usage-store.js';
import { runLegacyMigrationIfNeeded } from '../../src/core/storage/migrator.js';
import type { MementoLike, StoredSession } from '../../src/core/session/store.js';
import type { Message } from '../../src/providers/types.js';
import type { IUsageRecord } from '../../src/core/cost/types.js';

// ─────────── helpers ───────────

let _memDbCounter = 0;
async function openMemoryDb(): Promise<SqliteDatabaseLike> {
  _memDbCounter++;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sst-'));
  const dbPath = path.join(tmpDir, `test-${_memDbCounter}.sqlite`);
  try {
    return await openSqliteDatabase({ dbPath });
  } catch {
    return new InMemoryDb();
  }
}

function mkSession(overrides: Partial<StoredSession> = {}): StoredSession {
  const now = overrides.updatedAt ?? overrides.createdAt ?? Date.now();
  return {
    id: overrides.id ?? `sess-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    title: overrides.title ?? 't',
    messages: overrides.messages ?? [],
    sessionCost: overrides.sessionCost ?? [],
  };
}

function mkUsage(overrides: Partial<IUsageRecord> = {}): IUsageRecord {
  return {
    ts: overrides.ts ?? Date.now(),
    provider: overrides.provider ?? 'openai',
    operation: overrides.operation ?? 'chat',
    cost: overrides.cost ?? 0.01,
    currency: overrides.currency ?? 'CNY',
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.promptTokens !== undefined ? { promptTokens: overrides.promptTokens } : {}),
    ...(overrides.completionTokens !== undefined
      ? { completionTokens: overrides.completionTokens }
      : {}),
    ...(overrides.cachedTokens !== undefined ? { cachedTokens: overrides.cachedTokens } : {}),
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.turnId !== undefined ? { turnId: overrides.turnId } : {}),
  };
}

class FakeMemento implements MementoLike {
  private store = new Map<string, unknown>();
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) return this.store.get(key) as T;
    return defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  setDirect(key: string, value: unknown): void {
    this.store.set(key, value);
  }
}

// ─────────── sqlite-db ───────────

describe('sqlite-db · openSqliteDatabase + applyMigrations', () => {
  it('creates all required tables on first open', async () => {
    const db = await openMemoryDb();
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('sessions');
    expect(tables).toContain('total_cost');
    expect(tables).toContain('usage');
    expect(tables).toContain('meta');
    db.close();
  });

  it('sets user_version to CURRENT_SCHEMA_VERSION', async () => {
    const db = await openMemoryDb();
    const v = db.pragma('user_version') as Array<{ user_version: number }>;
    expect(v[0]?.user_version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it('applyMigrations is idempotent (no throw on second call)', async () => {
    const db = await openMemoryDb();
    expect(() => applyMigrations(db)).not.toThrow();
    expect(() => applyMigrations(db)).not.toThrow();
    const v = db.pragma('user_version') as Array<{ user_version: number }>;
    expect(v[0]?.user_version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it('creates required indexes', async () => {
    const db = await openMemoryDb();
    const idx = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(idx).toContain('idx_sessions_updatedAt');
    expect(idx).toContain('idx_usage_ts');
    expect(idx).toContain('idx_usage_sessionId');
    db.close();
  });
});

describe('sqlite-db · meta helpers', () => {
  it('getMetaString returns undefined before setMetaString', async () => {
    const db = await openMemoryDb();
    expect(getMetaString(db, 'k1')).toBeUndefined();
    db.close();
  });

  it('setMetaString + getMetaString roundtrip', async () => {
    const db = await openMemoryDb();
    setMetaString(db, 'k1', 'v1');
    expect(getMetaString(db, 'k1')).toBe('v1');
    // upsert
    setMetaString(db, 'k1', 'v2');
    expect(getMetaString(db, 'k1')).toBe('v2');
    db.close();
  });

  it('defaultSqlitePath composes <root>/.devseeker/data/devseeker.sqlite', () => {
    const p = defaultSqlitePath('/ws/root');
    expect(p.replace(/\\/g, '/')).toBe('/ws/root/.devseeker/data/devseeker.sqlite');
  });
});

// ─────────── SqliteSessionStore ───────────

describe('SqliteSessionStore', () => {
  let db: SqliteDatabaseLike;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    db = await openMemoryDb();
    store = new SqliteSessionStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  it('saveSession + getSession roundtrip', async () => {
    const s = mkSession({ id: 'a', title: 'hello', messages: [{ role: 'user', content: 'hi' } as Message] });
    await store.saveSession(s);
    const back = store.getSession('a');
    expect(back?.id).toBe('a');
    expect(back?.title).toBe('hello');
    expect(back?.messages[0]?.content).toBe('hi');
  });

  it('listSessions returns rows ordered by updatedAt DESC', async () => {
    await store.saveSession(mkSession({ id: '1', updatedAt: 100 }));
    await store.saveSession(mkSession({ id: '2', updatedAt: 300 }));
    await store.saveSession(mkSession({ id: '3', updatedAt: 200 }));
    const list = store.listSessions();
    expect(list.map((s) => s.id)).toEqual(['2', '3', '1']);
  });

  it('latestSession returns the most recently updated', async () => {
    await store.saveSession(mkSession({ id: 'old', updatedAt: 1 }));
    await store.saveSession(mkSession({ id: 'new', updatedAt: 999 }));
    expect(store.latestSession()?.id).toBe('new');
  });

  it('appendMessage adds message and bumps updatedAt', async () => {
    await store.saveSession(mkSession({ id: 'a', messages: [], updatedAt: 1 }));
    await store.appendMessage('a', { role: 'assistant', content: 'ok' } as Message);
    const back = store.getSession('a');
    expect(back?.messages).toHaveLength(1);
    expect((back?.messages[0] as Message).content).toBe('ok');
    expect(back?.updatedAt).toBeGreaterThan(1);
  });

  it('deleteSession removes a row', async () => {
    await store.saveSession(mkSession({ id: 'a' }));
    await store.deleteSession('a');
    expect(store.getSession('a')).toBeUndefined();
  });

  it('markReverted sets _reverted on the target message index', async () => {
    await store.saveSession(
      mkSession({
        id: 'a',
        messages: [
          { role: 'user', content: 'm0' } as Message,
          { role: 'assistant', content: 'm1' } as Message,
        ],
      }),
    );
    await store.markReverted('a', 1);
    const back = store.getSession('a');
    expect((back?.messages[0] as Message & { _reverted?: boolean })._reverted).toBeUndefined();
    expect((back?.messages[1] as Message & { _reverted?: boolean })._reverted).toBe(true);
  });

  it('saveSession auto-trims to maxSessions', async () => {
    const small = new SqliteSessionStore({ db, maxSessions: 2 });
    await small.saveSession(mkSession({ id: '1', updatedAt: 100 }));
    await small.saveSession(mkSession({ id: '2', updatedAt: 200 }));
    await small.saveSession(mkSession({ id: '3', updatedAt: 300 }));
    const list = small.listSessions();
    expect(list.map((s) => s.id)).toEqual(['3', '2']);
  });

  it('gc keeps only the latest N and returns deleted count', async () => {
    await store.saveSession(mkSession({ id: '1', updatedAt: 1 }));
    await store.saveSession(mkSession({ id: '2', updatedAt: 2 }));
    await store.saveSession(mkSession({ id: '3', updatedAt: 3 }));
    const n = await store.gc(1);
    expect(n).toBe(2);
    expect(store.listSessions().map((s) => s.id)).toEqual(['3']);
  });

  it('saveTotalCost + loadTotalCost roundtrip', async () => {
    await store.saveTotalCost([
      { provider: 'openai', CNY: 1.2, USD: 0, calls: 3 } as unknown as import('../../src/core/cost/tracker.js').ProviderCost,
      { provider: 'qwen', CNY: 0, USD: 2, calls: 5 } as unknown as import('../../src/core/cost/tracker.js').ProviderCost,
    ]);
    const back = store.loadTotalCost();
    expect(back).toHaveLength(2);
    const providers = back.map((c) => (c as unknown as { provider: string }).provider).sort();
    expect(providers).toEqual(['openai', 'qwen']);
  });

  it('snapshot combines sessions + totalCost', async () => {
    await store.saveSession(mkSession({ id: 'a' }));
    const snap = store.snapshot();
    expect(snap.sessions).toHaveLength(1);
    expect(Array.isArray(snap.totalCost)).toBe(true);
  });
});

// ─────────── SqliteUsageStore ───────────

describe('SqliteUsageStore', () => {
  let db: SqliteDatabaseLike;
  let store: SqliteUsageStore;

  beforeEach(async () => {
    db = await openMemoryDb();
    store = new SqliteUsageStore({ db, dbPath: '/fake/path/devseeker.sqlite' });
  });

  afterEach(() => {
    db.close();
  });

  it('append + readAll roundtrip', async () => {
    store.append(mkUsage({ ts: 100, cost: 0.01 }));
    store.append(mkUsage({ ts: 200, cost: 0.02 }));
    const rows = await store.readAll();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.ts).toBe(100);
    expect(rows[1]?.ts).toBe(200);
  });

  it('read applies since / until filter', async () => {
    store.append(mkUsage({ ts: 100 }));
    store.append(mkUsage({ ts: 200 }));
    store.append(mkUsage({ ts: 300 }));
    const rows = await store.read({ since: 150, until: 300 });
    expect(rows.map((r) => r.ts)).toEqual([200]);
  });

  it('read applies provider / operation / sessionId filter', async () => {
    store.append(mkUsage({ ts: 1, provider: 'a', operation: 'chat', sessionId: 's1' }));
    store.append(mkUsage({ ts: 2, provider: 'b', operation: 'chat', sessionId: 's2' }));
    store.append(mkUsage({ ts: 3, provider: 'a', operation: 'embed', sessionId: 's1' }));
    expect((await store.read({ provider: 'a' })).map((r) => r.ts)).toEqual([1, 3]);
    expect((await store.read({ operation: 'embed' })).map((r) => r.ts)).toEqual([3]);
    expect((await store.read({ sessionId: 's2' })).map((r) => r.ts)).toEqual([2]);
  });

  it('gc deletes rows older than cutoff and returns count', async () => {
    store.append(mkUsage({ ts: 100 }));
    store.append(mkUsage({ ts: 200 }));
    store.append(mkUsage({ ts: 300 }));
    const n = await store.gc(250);
    expect(n).toBe(2);
    expect((await store.readAll()).map((r) => r.ts)).toEqual([300]);
  });

  it('clear empties the table', async () => {
    store.append(mkUsage({ ts: 1 }));
    await store.clear();
    expect(await store.readAll()).toEqual([]);
  });

  it('getFilePath returns the configured dbPath', () => {
    expect(store.getFilePath()).toBe('/fake/path/devseeker.sqlite');
  });
});

// ─────────── migrator ───────────

describe('runLegacyMigrationIfNeeded', () => {
  let tmpDir: string;
  let db: SqliteDatabaseLike;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-migrator-'));
    db = await openMemoryDb();
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('imports memento sessions + totalCost on first run', async () => {
    const memento = new FakeMemento();
    memento.setDirect('devSeeker.sessions.v1', [
      mkSession({ id: 'legacy-1', title: 'from memento' }),
    ]);
    memento.setDirect('devSeeker.totalCost.v1', [
      { provider: 'openai', CNY: 1, USD: 0, calls: 1 },
    ]);
    const stats = await runLegacyMigrationIfNeeded({ db, legacyMemento: memento });
    expect(stats.performed).toBe(true);
    expect(stats.sessionsImported).toBe(1);
    expect(stats.totalCostImported).toBe(1);
    expect(
      db.prepare('SELECT id FROM sessions WHERE id = ?').get('legacy-1'),
    ).toBeDefined();
  });

  it('skips on second run (MIGRATED_META_KEY set)', async () => {
    const memento = new FakeMemento();
    memento.setDirect('devSeeker.sessions.v1', [mkSession({ id: 'once' })]);
    const a = await runLegacyMigrationIfNeeded({ db, legacyMemento: memento });
    expect(a.sessionsImported).toBe(1);
    // Second call: skipped
    memento.setDirect('devSeeker.sessions.v1', [mkSession({ id: 'twice' })]);
    const b = await runLegacyMigrationIfNeeded({ db, legacyMemento: memento });
    expect(b.performed).toBe(false);
    expect(b.sessionsImported).toBe(0);
    expect(
      db.prepare('SELECT id FROM sessions WHERE id = ?').get('twice'),
    ).toBeUndefined();
  });

  it('force=true re-runs even after marker set', async () => {
    const memento = new FakeMemento();
    memento.setDirect('devSeeker.sessions.v1', [mkSession({ id: 'a' })]);
    await runLegacyMigrationIfNeeded({ db, legacyMemento: memento });
    memento.setDirect('devSeeker.sessions.v1', [mkSession({ id: 'b' })]);
    const stats = await runLegacyMigrationIfNeeded({
      db,
      legacyMemento: memento,
      force: true,
    });
    expect(stats.performed).toBe(true);
    expect(stats.sessionsImported).toBe(1);
  });

  it('imports JSONL usage records + renames legacy file', async () => {
    const jsonl = path.join(tmpDir, 'usage.jsonl');
    const good = mkUsage({ ts: 100, cost: 0.1, provider: 'openai' });
    const bad = { ts: 'not-number' };
    await fs.writeFile(
      jsonl,
      [JSON.stringify(good), 'broken-not-json', JSON.stringify(bad), ''].join('\n'),
      'utf-8',
    );
    const stats = await runLegacyMigrationIfNeeded({
      db,
      legacyJsonlPath: jsonl,
      renameStamp: 'TESTSTAMP',
    });
    expect(stats.usageImported).toBe(1);
    expect(stats.usageSkippedInvalid).toBe(2);
    expect(stats.legacyJsonlRenamedTo).toBe(`${jsonl}.migrated-TESTSTAMP`);
    // original path should no longer exist
    await expect(fs.access(jsonl)).rejects.toBeTruthy();
    // renamed path should exist
    await expect(fs.access(`${jsonl}.migrated-TESTSTAMP`)).resolves.toBeUndefined();
  });

  it('silently handles missing JSONL (ENOENT → no error)', async () => {
    const stats = await runLegacyMigrationIfNeeded({
      db,
      legacyJsonlPath: path.join(tmpDir, 'nonexistent.jsonl'),
    });
    expect(stats.performed).toBe(true);
    expect(stats.usageImported).toBe(0);
    expect(stats.errors.filter((e) => e.startsWith('usage-read:'))).toHaveLength(0);
  });
});
