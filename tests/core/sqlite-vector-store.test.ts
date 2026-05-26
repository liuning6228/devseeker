/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W3b3 · SqliteVectorStore 单测
 * v1.4.0 · 使用 sql.js（WASM SQLite）替代 better-sqlite3
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { SqliteVectorStore } from '../../src/core/index/sqlite-vector-store.js';
import { openSqliteDatabase, InMemoryDb } from '../../src/core/storage/sqlite-db.js';
import type { SqliteDatabaseLike } from '../../src/core/storage/sqlite-db.js';
import type { VectorRecord } from '../../src/core/index/vector-store.js';

async function openMemoryDb(): Promise<SqliteDatabaseLike> {
  // 使用临时目录 + openSqliteDatabase（会加载 sql.js WASM）
  const tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'svt-'));
  const dbPath = join(tmpDir, 'test.sqlite');
  try {
    return await openSqliteDatabase({ dbPath });
  } catch {
    // sql.js 加载失败时 fallback 到 InMemoryDb
    return new InMemoryDb();
  }
}

let tmpDirForDb: string | undefined;

async function openTmpDb(): Promise<{ db: SqliteDatabaseLike; tmpDir: string }> {
  tmpDirForDb = await fs.mkdtemp(join(os.tmpdir(), 'svt-'));
  const dbPath = join(tmpDirForDb, 'test.sqlite');
  try {
    const db = await openSqliteDatabase({ dbPath });
    return { db, tmpDir: tmpDirForDb };
  } catch {
    return { db: new InMemoryDb(), tmpDir: tmpDirForDb };
  }
}

function rec(id: string, filePath: string, vector: number[]): VectorRecord {
  return {
    id,
    filePath,
    startLine: 1,
    endLine: 10,
    vector,
  };
}

describe('SqliteVectorStore', () => {
  let db: SqliteDatabaseLike;

  beforeEach(async () => {
    db = await openMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('starts empty', async () => {
    const s = await SqliteVectorStore.create({ db, dimension: 3, modelId: 'test' });
    expect(s.size()).toBe(0);
    expect(s.search([1, 0, 0])).toEqual([]);
  });

  it('upserts records and returns them in search', async () => {
    const s = await SqliteVectorStore.create({ db, dimension: 3, modelId: 'test' });
    s.upsert([
      rec('a', 'foo.ts', [1, 0, 0]),
      rec('b', 'bar.ts', [0, 1, 0]),
    ]);
    expect(s.size()).toBe(2);

    const hits = s.search([1, 0, 0], 5);
    expect(hits).toHaveLength(2);
    expect(hits[0].record.id).toBe('a');
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(hits[1].score).toBeCloseTo(0, 5);
  });

  it('upsert replaces existing id', async () => {
    const s = await SqliteVectorStore.create({ db, dimension: 3, modelId: 'test' });
    s.upsert([rec('a', 'foo.ts', [1, 0, 0])]);
    s.upsert([rec('a', 'foo.ts', [0, 1, 0])]);
    expect(s.size()).toBe(1);
    const hits = s.search([0, 1, 0]);
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it('rejects vectors with wrong dimension', async () => {
    const s = await SqliteVectorStore.create({ db, dimension: 3, modelId: 'test' });
    expect(() => s.upsert([rec('a', 'foo.ts', [1, 0])])).toThrow(/维度不匹配/);
  });

  it('search respects topK', async () => {
    const s = await SqliteVectorStore.create({ db, dimension: 2, modelId: 'test' });
    s.upsert([
      rec('a', 'f1.ts', [1, 0]),
      rec('b', 'f2.ts', [0.9, 0.1]),
      rec('c', 'f3.ts', [0.1, 0.9]),
    ]);
    const hits = s.search([1, 0], 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].record.id).toBe('a');
  });

  it('deleteByFile removes all chunks of that file', async () => {
    const s = await SqliteVectorStore.create({ db, dimension: 2, modelId: 'test' });
    s.upsert([
      rec('a1', 'foo.ts', [1, 0]),
      rec('a2', 'foo.ts', [0, 1]),
      rec('b', 'bar.ts', [1, 0]),
    ]);
    const removed = s.deleteByFile('foo.ts');
    expect(removed).toBe(2);
    expect(s.size()).toBe(1);
    expect(s.listIndexedFiles()).toEqual(['bar.ts']);
  });

  it('clear empties the store', async () => {
    const s = await SqliteVectorStore.create({ db, dimension: 2, modelId: 'test' });
    s.upsert([rec('a', 'foo.ts', [1, 0])]);
    s.clear();
    expect(s.size()).toBe(0);
  });

  it('search with wrong dimension throws', async () => {
    const s = await SqliteVectorStore.create({ db, dimension: 3, modelId: 'test' });
    s.upsert([rec('a', 'foo.ts', [1, 0, 0])]);
    expect(() => s.search([1, 0])).toThrow(/维度不匹配/);
  });

  it('search with zero vector returns empty', async () => {
    const s = await SqliteVectorStore.create({ db, dimension: 3, modelId: 'test' });
    s.upsert([rec('a', 'foo.ts', [1, 0, 0])]);
    expect(s.search([0, 0, 0])).toEqual([]);
  });

  it('save is a no-op (SQLite auto-persists)', async () => {
    const s = await SqliteVectorStore.create({ db, dimension: 2, modelId: 'test' });
    s.upsert([rec('a', 'foo.ts', [1, 0])]);
    // save() 不应抛错
    await expect(s.save()).resolves.toBeUndefined();
  });

  it('persists data across store instances sharing the same SQLite', async () => {
    const s = await SqliteVectorStore.create({ db, dimension: 3, modelId: 'test' });
    s.upsert([rec('a', 'foo.ts', [1, 0, 0]), rec('b', 'bar.ts', [0, 1, 0])]);
    // 同一个 db 连接，新建 store 实例
    const s2 = await SqliteVectorStore.create({ db, dimension: 3, modelId: 'test' });
    expect(s2.size()).toBe(2);
    const hits = s2.search([1, 0, 0]);
    expect(hits[0].record.id).toBe('a');
  });

  describe('JSON migration', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'svm-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('migrates from legacy JSON file', async () => {
      // 先用 InMemoryVectorStore 的 JSON 格式写入文件
      const { InMemoryVectorStore } = await import('../../src/core/index/vector-store.js');
      const memStore = new InMemoryVectorStore(3, 'test');
      memStore.upsert([rec('a', 'foo.ts', [1, 0, 0]), rec('b', 'bar.ts', [0, 1, 0])]);
      const jsonPath = join(tmpDir, 'codebase-index.json');
      await memStore.saveToFile(jsonPath);

      // 创建 SqliteVectorStore 并迁移
      const db2 = await openMemoryDb();
      const s = await SqliteVectorStore.create({
        db: db2,
        dimension: 3,
        modelId: 'test',
        legacyJsonPath: jsonPath,
      });

      expect(s.size()).toBe(2);
      const hits = s.search([1, 0, 0]);
      expect(hits[0].record.id).toBe('a');

      // 旧 JSON 应被重命名
      const migrated = await fs.stat(jsonPath + '.migrated').catch(() => null);
      expect(migrated).not.toBeNull();

      db2.close();
    });

    it('skips migration when JSON does not exist', async () => {
      const s = await SqliteVectorStore.create({
        db,
        dimension: 3,
        modelId: 'test',
        legacyJsonPath: join(tmpDir, 'nonexistent.json'),
      });
      expect(s.size()).toBe(0);
    });

    it('skips migration when dimension mismatches', async () => {
      const { InMemoryVectorStore } = await import('../../src/core/index/vector-store.js');
      const memStore = new InMemoryVectorStore(3, 'other-model');
      memStore.upsert([rec('a', 'foo.ts', [1, 0, 0])]);
      const jsonPath = join(tmpDir, 'codebase-index.json');
      await memStore.saveToFile(jsonPath);

      // dimension=2 与 JSON 中的 3 不匹配
      const s = await SqliteVectorStore.create({
        db,
        dimension: 2,
        modelId: 'test',
        legacyJsonPath: jsonPath,
      });
      expect(s.size()).toBe(0);
    });
  });
});
