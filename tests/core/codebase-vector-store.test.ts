/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * InMemoryVectorStore 单测
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { InMemoryVectorStore, type VectorRecord } from '../../src/core/index/vector-store.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

function rec(id: string, filePath: string, vector: number[]): VectorRecord {
  return {
    id,
    filePath,
    startLine: 1,
    endLine: 10,
    vector,
  };
}

describe('InMemoryVectorStore', () => {
  it('starts empty', () => {
    const s = new InMemoryVectorStore(3, 'test');
    expect(s.size()).toBe(0);
    expect(s.search([1, 0, 0])).toEqual([]);
  });

  it('upserts records and returns them in search', () => {
    const s = new InMemoryVectorStore(3, 'test');
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

  it('upsert replaces existing id', () => {
    const s = new InMemoryVectorStore(3, 'test');
    s.upsert([rec('a', 'foo.ts', [1, 0, 0])]);
    s.upsert([rec('a', 'foo.ts', [0, 1, 0])]);
    expect(s.size()).toBe(1);
    const hits = s.search([0, 1, 0]);
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it('rejects vectors with wrong dimension', () => {
    const s = new InMemoryVectorStore(3, 'test');
    expect(() => s.upsert([rec('a', 'foo.ts', [1, 0])])).toThrow(/维度不匹配/);
  });

  it('search respects topK', () => {
    const s = new InMemoryVectorStore(2, 'test');
    s.upsert([
      rec('a', 'f1.ts', [1, 0]),
      rec('b', 'f2.ts', [0.9, 0.1]),
      rec('c', 'f3.ts', [0.1, 0.9]),
    ]);
    const hits = s.search([1, 0], 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].record.id).toBe('a');
  });

  it('deleteByFile removes all chunks of that file', () => {
    const s = new InMemoryVectorStore(2, 'test');
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

  it('clear empties the store', () => {
    const s = new InMemoryVectorStore(2, 'test');
    s.upsert([rec('a', 'foo.ts', [1, 0])]);
    s.clear();
    expect(s.size()).toBe(0);
  });

  it('search with wrong dimension throws', () => {
    const s = new InMemoryVectorStore(3, 'test');
    s.upsert([rec('a', 'foo.ts', [1, 0, 0])]);
    expect(() => s.search([1, 0])).toThrow(/维度不匹配/);
  });

  it('search with zero vector returns empty', () => {
    const s = new InMemoryVectorStore(3, 'test');
    s.upsert([rec('a', 'foo.ts', [1, 0, 0])]);
    expect(s.search([0, 0, 0])).toEqual([]);
  });

  describe('persistence', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'vs-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('saveToFile + loadFromFile round-trip', async () => {
      const s = new InMemoryVectorStore(3, 'test-model');
      s.upsert([rec('a', 'foo.ts', [1, 0, 0]), rec('b', 'bar.ts', [0, 1, 0])]);
      const file = join(tmpDir, 'vs.json');
      await s.saveToFile(file);

      const loaded = await InMemoryVectorStore.loadFromFile(file);
      expect(loaded).toBeDefined();
      expect(loaded!.size()).toBe(2);
      expect(loaded!.dimension).toBe(3);
      expect(loaded!.modelId).toBe('test-model');
      const hits = loaded!.search([1, 0, 0]);
      expect(hits[0].record.id).toBe('a');
    });

    it('loadFromFile returns undefined for missing file', async () => {
      const result = await InMemoryVectorStore.loadFromFile(join(tmpDir, 'missing.json'));
      expect(result).toBeUndefined();
    });

    it('loadFromFile throws CORRUPTED on bad JSON', async () => {
      const file = join(tmpDir, 'bad.json');
      await fs.writeFile(file, '{not json');
      await expect(InMemoryVectorStore.loadFromFile(file)).rejects.toMatchObject({
        code: ErrorCodes.INDEX_DB_CORRUPTED,
      });
    });

    it('loadFromFile throws CORRUPTED on wrong version', async () => {
      const file = join(tmpDir, 'wrong-version.json');
      await fs.writeFile(
        file,
        JSON.stringify({
          version: 99,
          dimension: 3,
          modelId: 't',
          createdAt: 1,
          updatedAt: 1,
          records: [],
        }),
      );
      await expect(InMemoryVectorStore.loadFromFile(file)).rejects.toMatchObject({
        code: ErrorCodes.INDEX_DB_CORRUPTED,
      });
    });

    it('creates directory automatically on saveToFile', async () => {
      const s = new InMemoryVectorStore(2, 'test');
      s.upsert([rec('a', 'foo.ts', [1, 0])]);
      const file = join(tmpDir, 'nested', 'deep', 'vs.json');
      await s.saveToFile(file);
      const stat = await fs.stat(file);
      expect(stat.isFile()).toBe(true);
    });
  });
});
