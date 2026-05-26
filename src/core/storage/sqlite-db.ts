/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-P1-16 · SQLite 统一连接管理（DESIGN §M16.6）
 *
 * v1.8.3 · 从 sql.js 回退到 better-sqlite3（原生 C 模块）
 * ─────────────────────────────────────────────────────
 * 根因：sql.js（WASM SQLite）是纯内存数据库，DELETE 不归还 WASM 堆，
 *      导致 dualmind.sqlite 文件持续膨胀到几百 MB；搜索时全表反序列化
 *      BLOB→JS number[] 打爆 Extension Host 堆内存。
 *
 * better-sqlite3 是原生 C 模块，数据在 SQLite 页缓存中由 C 层管理，
 * 不会向 JS 堆膨胀。搜索时 cosine 距离在 C 层计算，只返回 top-K 结果。
 *
 * 回退策略：
 * - 优先加载 better-sqlite3（同步 API，磁盘原生）
 * - better-sqlite3 加载失败时（.node ABI 不匹配等），fallback 到 sql.js
 * - sql.js 也失败时，fallback 到 InMemoryDb（仅保证面板不崩溃）
 *
 * 核心差异（vs sql.js）：
 * - sync API（better-sqlite3 是同步的；openSqliteDatabase 接口仍为 async）
 * - 支持 WAL 模式
 * - 支持 PRAGMA key = value 语法
 * - lastInsertRowid 正确返回
 * - 不需要 export() 写盘——数据实时落盘
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import BetterSqlite3, { type Database as BSqliteDb, type Statement as BSqliteStmt } from 'better-sqlite3';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('sqlite.db');

// ─────────── 公共接口（与 better-sqlite3 时代完全兼容） ───────────

/** 兼容 SQLite 的最小接口（便于单测 stub） */
export interface SqliteDatabaseLike {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStmtLike;
  close(): void;
  pragma(q: string): unknown;
}

export interface SqliteStmtLike {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

/** 当前最新 schema 版本；每次新增迁移递增。 */
export const CURRENT_SCHEMA_VERSION = 2;

// ─────────── better-sqlite3 包装层 ───────────

/**
 * better-sqlite3 的 Database 包装为 SqliteDatabaseLike。
 *
 * better-sqlite3 是原生 C 模块，数据直接落磁盘页缓存（由 SQLite 内核管理），
 * 不会像 sql.js WASM 那样在 JS 堆中持续膨胀。搜索时 cosine 计算也在 C 层完成。
 *
 * 关键差异：
 * - 同步 API（与 sql.js 的异步初始化不同，但 openSqliteDatabase 仍返回 async）
 * - WAL 模式支持（并发读不阻塞写）
 * - `lastInsertRowid` 在 `run()` 后正确返回
 * - `pragma()` 支持 `PRAGMA key = value` 语法
 */
class BSqlite3Db implements SqliteDatabaseLike {
  private db: BSqliteDb;
  private readonly dbPath: string;
  private closed = false;

  constructor(db: BSqliteDb, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  exec(sql: string): unknown {
    this.db.exec(sql);
    return undefined;
  }

  prepare(sql: string): SqliteStmtLike {
    const stmt = this.db.prepare(sql);
    return new BSqlite3Stmt(stmt);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  pragma(q: string): unknown {
    try {
      // better-sqlite3 支持 PRAGMA key = value 语法
      const result = this.db.pragma(q);
      return result;
    } catch (e) {
      log.warn({ err: String(e), pragma: q }, 'pragma failed');
      return [];
    }
  }
}

/** better-sqlite3 Statement → SqliteStmtLike 包装 */
class BSqlite3Stmt implements SqliteStmtLike {
  constructor(private readonly stmt: BSqliteStmt) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const info = this.stmt.run(...params);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  get(...params: unknown[]): unknown {
    return this.stmt.get(...params) ?? undefined;
  }

  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...params);
  }

  iterate(...params: unknown[]): IterableIterator<unknown> {
    return this.stmt.iterate(...params) as unknown as IterableIterator<unknown>;
  }
}

// ─────────── sql.js 包装层（保留为 fallback） ───────────

/**
 * sql.js 的 Database 包装为 SqliteDatabaseLike。
 *
 * sql.js 是纯内存的 SQLite，需要手动 export() 持久化到磁盘。
 * 每次写操作后 debounce 写盘（200ms），close() 时同步写盘。
 *
 * 注意：这是 fallback 路径。优先使用 better-sqlite3。
 */
class SqlJsDatabase implements SqliteDatabaseLike {
  private readonly inner: SqlJsInnerDb;
  private readonly dbPath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(inner: SqlJsInnerDb, dbPath: string) {
    this.inner = inner;
    this.dbPath = dbPath;
  }

  exec(sql: string): unknown {
    // sql.js 的 exec() 可以执行多条 SQL，返回结果数组
    // 但对于 DDL/DML 我们用 run()，它不返回结果
    this.inner.run(sql);
    this.scheduleSave();
    return undefined;
  }

  prepare(sql: string): SqliteStmtLike {
    return new SqlJsStmt(this.inner, sql, () => this.scheduleSave());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // 取消 debounce，立即写盘
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveToDisk();
    this.inner.close();
  }

  pragma(q: string): unknown {
    // sql.js 不支持 PRAGMA 赋值语法（PRAGMA key=value），
    // 但支持 PRAGMA key 读取。赋值通过 exec(SQL) 方式。
    const pragmaSql = `PRAGMA ${q}`;
    try {
      const results = this.inner.exec(pragmaSql);
      if (results.length > 0 && results[0]) {
        // results[0] = { columns: string[], values: unknown[][] }
        const cols = results[0].columns;
        const vals = results[0].values;
        // 转换为 better-sqlite3 风格的 [{col: val, ...}]
        return vals.map(row => {
          const obj: Record<string, unknown> = {};
          for (let i = 0; i < cols.length; i++) {
            obj[cols[i]] = row[i];
          }
          return obj;
        });
      }
      return [];
    } catch {
      // PRAGMA 赋值（如 PRAGMA user_version = 1）会抛错，
      // 因为 sql.js exec 不支持无结果集的 PRAGMA 赋值
      // 改用 run() 执行
      try {
        this.inner.run(pragmaSql);
        this.scheduleSave();
        return [];
      } catch (e2) {
        log.warn({ err: String(e2), pragma: q }, 'pragma failed');
        return [];
      }
    }
  }

  /** Debounce 写盘：200ms 内多次写只触发一次 */
  private scheduleSave(): void {
    if (this.closed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, 200);
  }

  private saveToDisk(): void {
    if (this.closed && this.inner === null) return;
    try {
      const data = this.inner.export();
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.dbPath, Buffer.from(data));
    } catch (e) {
      log.error({ err: String(e), path: this.dbPath }, 'failed to save SQLite to disk');
    }
  }
}

/**
 * sql.js 的 prepare().bind().step().getAsObject() 包装为
 * better-sqlite3 风格的 stmt.run() / stmt.get() / stmt.all()
 */
class SqlJsStmt implements SqliteStmtLike {
  private readonly db: SqlJsInnerDb;
  private readonly sql: string;
  private readonly onSave: () => void;

  constructor(db: SqlJsInnerDb, sql: string, onSave: () => void) {
    this.db = db;
    this.sql = sql;
    this.onSave = onSave;
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    // 判断 SQL 类型：SELECT 不应该通过此路径
    // 使用 sql.js 的 exec() 执行带参数的 SQL
    // sql.js 没有 prepare+bind+run 的同步 API，
    // 最简单的方式是用 db.exec() + 参数替换，但有 SQL 注入风险
    // 更安全：用 prepare + bind + step
    try {
      const stmt = this.db.prepare(this.sql);
      if (params.length > 0) {
        stmt.bind(params);
      }
      stmt.step();
      const changes = this.db.getRowsModified();
      const lastId = 0; // sql.js 不直接暴露 lastInsertRowid
      stmt.free();
      this.onSave();
      return { changes, lastInsertRowid: lastId };
    } catch (e) {
      log.error({ err: String(e), sql: this.sql }, 'SqlJsStmt.run failed');
      return { changes: 0, lastInsertRowid: 0 };
    }
  }

  get(...params: unknown[]): unknown {
    try {
      const stmt = this.db.prepare(this.sql);
      if (params.length > 0) {
        stmt.bind(params);
      }
      let result: unknown = undefined;
      if (stmt.step()) {
        result = stmt.getAsObject();
      }
      stmt.free();
      return result;
    } catch (e) {
      log.error({ err: String(e), sql: this.sql }, 'SqlJsStmt.get failed');
      return undefined;
    }
  }

  all(...params: unknown[]): unknown[] {
    try {
      const stmt = this.db.prepare(this.sql);
      if (params.length > 0) {
        stmt.bind(params);
      }
      const results: unknown[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
      return results;
    } catch (e) {
      log.error({ err: String(e), sql: this.sql }, 'SqlJsStmt.all failed');
      return [];
    }
  }

  *iterate(...params: unknown[]): IterableIterator<unknown> {
    try {
      const stmt = this.db.prepare(this.sql);
      if (params.length > 0) {
        stmt.bind(params);
      }
      while (stmt.step()) {
        yield stmt.getAsObject();
      }
      stmt.free();
    } catch (e) {
      log.error({ err: String(e), sql: this.sql }, 'SqlJsStmt.iterate failed');
    }
  }
}

// ─────────── sql.js 类型声明（无 @types/sql.js，手动声明） ───────────

interface SqlJsInnerDb {
  run(sql: string): void;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): SqlJsInnerStmt;
  export(): Uint8Array;
  close(): void;
  getRowsModified(): number;
}

interface SqlJsInnerStmt {
  bind(params: unknown[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
}

type InitSqlJsModule = {
  Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsInnerDb;
};

// ─────────── sql.js 懒加载单例 ───────────

let sqlJsModulePromise: Promise<InitSqlJsModule> | null = null;

async function loadSqlJs(): Promise<InitSqlJsModule> {
  if (sqlJsModulePromise) return sqlJsModulePromise;

  sqlJsModulePromise = (async () => {
    const req = (globalThis as unknown as { require?: NodeRequire }).require ?? eval('require');

    // 确定 WASM 文件路径
    // 在 VSIX 中：sql-wasm.wasm 位于 node_modules/sql.js/dist/sql-wasm.wasm
    // 扩展根目录通过 __dirname 或 process.cwd() 获取
    let wasmPath: string | undefined;
    try {
      // 尝试从扩展根目录定位 WASM 文件
      const possibleRoots = [
        // 开发模式：从项目根目录
        path.resolve(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
        // 打包模式：从扩展安装目录（out/ 上一级）
        path.resolve(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
        // VSIX 安装模式：从 out/ 上两级
        path.resolve(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      ];
      for (const p of possibleRoots) {
        if (fs.existsSync(p)) {
          wasmPath = p;
          break;
        }
      }
    } catch { /* ignore */ }

    const initSqlJs = req('sql.js') as (config?: { locateFile?: (file: string) => string }) => Promise<InitSqlJsModule>;

    const module = await initSqlJs({
      locateFile: (file: string) => {
        if (wasmPath && file.endsWith('.wasm')) {
          return wasmPath;
        }
        // 回退：让 sql.js 用默认路径解析
        return file;
      },
    });

    log.info({ wasmPath }, 'sql.js WASM module loaded');
    return module;
  })();

  return sqlJsModulePromise;
}

// ─────────── 内存 stub（sql.js 加载失败时的 fallback） ───────────

export class InMemoryStmt implements SqliteStmtLike {
  private rows: unknown[] = [];
  run(..._params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return { changes: 0, lastInsertRowid: 0 };
  }
  get(..._params: unknown[]): unknown { return undefined; }
  all(..._params: unknown[]): unknown[] { return this.rows; }
  iterate(..._params: unknown[]): IterableIterator<unknown> { return this.rows[Symbol.iterator](); }
}

export class InMemoryDb implements SqliteDatabaseLike {
  private data = new Map<string, unknown>();
  exec(_sql: string): unknown { return undefined; }
  prepare(_sql: string): SqliteStmtLike { return new InMemoryStmt(); }
  close(): void { this.data.clear(); }
  pragma(q: string): unknown {
    const m = q.match(/user_version\s*=\s*(\d+)/);
    if (m) { this.data.set('user_version', parseInt(m[1], 10)); return []; }
    if (q.includes('user_version')) {
      const v = (this.data.get('user_version') as number) ?? 0;
      return [{ user_version: v }];
    }
    return [];
  }
}

// ─────────── 公共 API ───────────

export interface OpenSqliteOptions {
  /** 数据库文件绝对路径；调用方负责确保目录已创建 */
  dbPath: string;
  /** 工厂：测试可注入 in-memory 或 stub；默认 lazily load sql.js */
  factory?: (filePath: string) => SqliteDatabaseLike | Promise<SqliteDatabaseLike>;
}

/**
 * 打开 SQLite 连接并应用必要迁移。
 * v1.8.3 · better-sqlite3 主路径（同步），sql.js fallback（async）。
 * 每次调用都新建一个 Database 实例；调用方自己缓存。
 */
export async function openSqliteDatabase(opts: OpenSqliteOptions): Promise<SqliteDatabaseLike> {
  const factory = opts.factory ?? defaultFactory;
  const db = await factory(opts.dbPath);
  applyMigrations(db);
  return db;
}

async function defaultFactory(filePath: string): Promise<SqliteDatabaseLike> {
  // 1) 优先加载 better-sqlite3（原生 C 模块）
  try {
    ensureDirExists(path.dirname(filePath));
    const db = new BetterSqlite3(filePath);
    // 启用 WAL 模式：并发读不阻塞写，且数据实时落盘
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    log.info({ path: filePath }, 'SQLite database opened (better-sqlite3)');
    return new BSqlite3Db(db, filePath);
  } catch (err) {
    log.warn({ err: String(err) }, 'better-sqlite3 not available, falling back to sql.js');
  }

  // 2) better-sqlite3 不可用 → fallback 到 sql.js（WASM）
  try {
    const SQL = await loadSqlJs();

    let db: SqlJsInnerDb;
    if (fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      db = new SQL.Database(buffer);
      log.info({ path: filePath, size: buffer.length }, 'SQLite database loaded from disk (sql.js)');
    } else {
      db = new SQL.Database();
      log.info({ path: filePath }, 'SQLite database created (sql.js)');
    }

    return new SqlJsDatabase(db, filePath);
  } catch (err) {
    log.error({ err: String(err) }, 'sql.js WASM module not available, using in-memory stub');
    // Graceful fallback: 返回一个内存 stub，保证面板不崩溃
    // 功能受限（无法持久化），但核心 UI 可用
    return new InMemoryDb();
  }
}

/** 确保目录存在 */
function ensureDirExists(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* noop */
  }
}

function applyPragmas(db: SqliteDatabaseLike): void {
  try {
    // WAL 模式：better-sqlite3 支持；sql.js 跳过此 pragma（静默失败）
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  } catch (e) {
    log.warn({ err: String(e) }, 'pragma apply failed');
  }
}

/**
 * 基于 `PRAGMA user_version` 做线性迁移：
 *   v0 (初始) → v1 (当前 schema)
 * 后续新增版本时：
 *   if (v < 2) { db.exec(migrations_for_v2); db.pragma('user_version = 2'); }
 */
export function applyMigrations(db: SqliteDatabaseLike): void {
  const row = db.pragma('user_version') as Array<{ user_version: number }> | number;
  // better-sqlite3 pragma(string) 默认返回对象数组；加 `, { simple: true }` 返回数字。
  // 这里按数组形式容错读取，支持两种返回格式。
  let current = 0;
  if (Array.isArray(row)) {
    current = Number(row[0]?.user_version ?? 0);
  } else if (typeof row === 'number') {
    current = row;
  }
  if (current < 1) {
    db.exec(SCHEMA_V1);
    db.pragma('user_version = 1');
  }
  if (current < 2) {
    // 双库分离 v2：删除会话库中的旧索引表（索引已迁移到 dualmind-index.sqlite）
    db.exec(`
      DROP TABLE IF EXISTS vec_records;
      DROP TABLE IF EXISTS vec_meta;
    `);
    db.pragma('user_version = 2');
  }
}

/** 初始 schema（v1）。所有建表使用 IF NOT EXISTS 保证幂等。 */
export const SCHEMA_V1 = /* sql */ `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  createdAt   INTEGER NOT NULL,
  updatedAt   INTEGER NOT NULL,
  title       TEXT NOT NULL,
  messages    TEXT NOT NULL,
  sessionCost TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_updatedAt ON sessions(updatedAt DESC);

CREATE TABLE IF NOT EXISTS total_cost (
  provider TEXT PRIMARY KEY,
  data     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  provider          TEXT NOT NULL,
  model             TEXT,
  operation         TEXT NOT NULL,
  promptTokens      INTEGER,
  completionTokens  INTEGER,
  cachedTokens      INTEGER,
  cost              REAL NOT NULL,
  currency          TEXT NOT NULL,
  sessionId         TEXT,
  turnId            TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts         ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_sessionId  ON usage(sessionId);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// ─────────── meta helpers ───────────

export function getMetaString(db: SqliteDatabaseLike, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMetaString(db: SqliteDatabaseLike, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** 决定 workspace 下 sqlite db 的默认路径：`<root>/.dualmind/data/dualmind.sqlite` */
export function defaultSqlitePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.dualmind', 'data', 'dualmind.sqlite');
}

/** 向量索引专用库路径（与会话/用量分库）：`<root>/.dualmind/data/dualmind-index.sqlite` */
export function defaultIndexSqlitePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.dualmind', 'data', 'dualmind-index.sqlite');
}
