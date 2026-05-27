/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CodebaseIndex 增量更新单测
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { CodebaseIndex } from '../../src/core/index/codebase-index.js';
import type { Embedder, EmbedResult } from '../../src/core/index/embedder.js';
import { openSqliteDatabase, InMemoryDb } from '../../src/core/storage/sqlite-db.js';
import type { SqliteDatabaseLike } from '../../src/core/storage/sqlite-db.js';

class FakeEmbedder implements Embedder {
  readonly dimension = 3;
  readonly modelId = 'fake';
  calls = 0;
  async embed(inputs: string[]): Promise<EmbedResult> {
    this.calls++;
    return {
      vectors: inputs.map((s) => {
        const v = [0, 0, 0];
        for (const ch of s.toLowerCase()) {
          if (ch === 'a') v[0]++;
          else if (ch === 'b') v[1]++;
          else v[2]++;
        }
        return v;
      }),
    };
  }
}

let tmpRoot: string;
let storePath: string;
let db: SqliteDatabaseLike;

async function mkfile(rel: string, content: string): Promise<void> {
  const abs = join(tmpRoot, rel);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'cbi-inc-'));
  storePath = join(tmpRoot, '.devseeker', 'index.json');
  try {
    db = await openSqliteDatabase({ dbPath: join(tmpRoot, 'test.sqlite') });
  } catch {
    db = new InMemoryDb();
  }
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function buildIndex(): Promise<{ index: CodebaseIndex; embedder: FakeEmbedder }> {
  const embedder = new FakeEmbedder();
  const index = await CodebaseIndex.create({
    workspaceRoot: tmpRoot,
    embedder,
    db,
    storePath,
  });
  return { index, embedder };
}

describe('CodebaseIndex incremental', () => {
  it('updateFile re-embeds changed content', async () => {
    await mkfile('a.ts', 'aaa aaa');
    const { index } = await buildIndex();
    await index.reindex();
    expect(index.size()).toBe(1);

    await mkfile('a.ts', 'bbb bbb bbb');
    const { removed, added } = await index.updateFile('a.ts');
    expect(removed).toBe(1);
    expect(added).toBe(1);

    const hits = await index.search('bbb', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].filePath).toBe('a.ts');
  });

  it('updateFile on missing file acts as remove', async () => {
    await mkfile('a.ts', 'aaa');
    const { index } = await buildIndex();
    await index.reindex();
    expect(index.size()).toBe(1);

    await fs.unlink(join(tmpRoot, 'a.ts'));
    const { removed, added } = await index.updateFile('a.ts');
    expect(removed).toBe(1);
    expect(added).toBe(0);
    expect(index.size()).toBe(0);
  });

  it('removeFile deletes all chunks of that file', async () => {
    await mkfile('a.ts', 'aaa\naaa\naaa');
    await mkfile('b.ts', 'bbb');
    const { index } = await buildIndex();
    await index.reindex();
    const before = index.size();
    expect(before).toBeGreaterThan(0);

    const { removed, added } = index.removeFile('a.ts');
    expect(removed).toBeGreaterThan(0);
    expect(added).toBe(0);
    expect(index.size()).toBe(before - removed);
    expect(index.listIndexedFiles()).not.toContain('a.ts');
  });

  it('removeFile on non-indexed file is no-op', async () => {
    await mkfile('a.ts', 'aaa');
    const { index } = await buildIndex();
    await index.reindex();
    const { removed } = index.removeFile('not-in-index.ts');
    expect(removed).toBe(0);
  });

  it('updateFile persists to disk', async () => {
    await mkfile('a.ts', 'aaa');
    const { index } = await buildIndex();
    await index.reindex();

    await mkfile('a.ts', 'bbb');
    await index.updateFile('a.ts');

    // 重新加载应看到更新后的内容
    const index2 = await CodebaseIndex.create({
      workspaceRoot: tmpRoot,
      embedder: new FakeEmbedder(),
      db,
      storePath,
    });
    const hits = await index2.search('bbb', 5);
    expect(hits.length).toBeGreaterThan(0);
  });
});
