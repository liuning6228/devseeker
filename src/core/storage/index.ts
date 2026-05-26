/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-P1-16 · storage/index.ts —— SQLite 存储层统一导出
 */

export {
  openSqliteDatabase,
  applyMigrations,
  getMetaString,
  setMetaString,
  defaultSqlitePath,
  SCHEMA_V1,
  CURRENT_SCHEMA_VERSION,
  type SqliteDatabaseLike,
  type SqliteStmtLike,
  type OpenSqliteOptions,
  InMemoryDb,
} from './sqlite-db.js';

export {
  SqliteSessionStore,
  type SqliteSessionStoreOptions,
} from './sqlite-session-store.js';

export {
  SqliteUsageStore,
  type SqliteUsageStoreOptions,
} from './sqlite-usage-store.js';

export {
  runLegacyMigrationIfNeeded,
  type MigrationStats,
  type RunLegacyMigrationOptions,
} from './migrator.js';
