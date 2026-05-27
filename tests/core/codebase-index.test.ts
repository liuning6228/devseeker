/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CodebaseIndex 协调器单测
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { CodebaseIndex } from '../../src/core/index/codebase-index.js';
import type { Embedder, EmbedResult } from '../../src/core/index/embedder.js';
import { openSqliteDatabase, InMemoryDb } from '../../src/core/storage/sqlite-db.js';
import type { SqliteDatabaseLike } from '../../src/core/storage/sqlite-db.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

/** 确定性伪 embedder：输出基于字符统计的 3 维向量 */
class FakeEmbedder implements Embedder {
  readonly dimension = 3;
  readonly modelId = 'fake-v1';
  calls = 0;
  inputs: string[][] = [];

  async embed(inputs: string[]): Promise<EmbedResult> {
    this.calls++;
    this.inputs.push(inputs);
    const vectors = inputs.map((s) => this.vectorize(s));
    return { vectors, totalTokens: inputs.reduce((sum, s) => sum + s.length, 0) };
  }

  private vectorize(s: string): number[] {
    // 基于关键词的确定性向量
    const v = [0, 0, 0];
    for (const ch of s.toLowerCase()) {
      if (ch === 'a') v[0]++;
      else if (ch === 'b') v[1]++;
      else v[2]++;
    }
    return v;
  }
}

let tmpRoot: string;
let storePath: string;
let db: SqliteDatabaseLike;
/** 本测试用例中创建的所有 CodebaseIndex 实例，afterEach 时 dispose 释放 SQLite 连接 */
const idxArr: CodebaseIndex[] = [];

async function mkfile(rel: string, content: string): Promise<void> {
  const abs = join(tmpRoot, rel);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'cbi-'));
  storePath = join(tmpRoot, '.devseeker', 'index.json');
  idxArr.length = 0;
  try {
    db = await openSqliteDatabase({ dbPath: join(tmpRoot, 'test.sqlite') });
  } catch {
    db = new InMemoryDb();
  }
});

afterEach(async () => {
  // 必须先 dispose 内部 SQLite 连接，否则 Windows 上文件锁不释放 → EBUSY
  for (const idx of idxArr) idx.dispose();
  idxArr.length = 0;
  db.close();
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
});

describe('CodebaseIndex', () => {
  it('creates empty index when no snapshot exists', async () => {
    const idx = await CodebaseIndex.create({
      workspaceRoot: tmpRoot,
      embedder: new FakeEmbedder(),
      db,
      storePath,
    });
    idxArr.push(idx);
    expect(idx.size()).toBe(0);
  });

  it('reindex scans, chunks, embeds and stores', async () => {
    await mkfile('a.ts', 'aaa aaa\nbbb bbb');
    await mkfile('b.ts', 'ccc ddd\neee fff');

    const embedder = new FakeEmbedder();
    const idx = await CodebaseIndex.create({
      workspaceRoot: tmpRoot,
      embedder,
      db,
      storePath,
    });
    idxArr.push(idx);
    const stats = await idx.reindex();

    expect(stats.filesScanned).toBe(2);
    expect(stats.chunksEmbedded).toBeGreaterThan(0);
    expect(idx.size()).toBe(stats.chunksEmbedded);
    expect(embedder.calls).toBeGreaterThan(0);
  });

  it('search returns most relevant chunk', async () => {
    await mkfile('a.ts', 'aaaaaaaa');
    await mkfile('b.ts', 'bbbbbbbb');

    const idx = await CodebaseIndex.create({
      workspaceRoot: tmpRoot,
      embedder: new FakeEmbedder(),
      db,
      storePath,
    });
    idxArr.push(idx);
    await idx.reindex();

    const hits = await idx.search('aaaa', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].filePath).toBe('a.ts');
    expect(hits[0].score).toBeGreaterThan(0.9);
  });

  it('search throws INDEX_NOT_READY on empty index', async () => {
    const idx = await CodebaseIndex.create({
      workspaceRoot: tmpRoot,
      embedder: new FakeEmbedder(),
      db,
      storePath,
    });
    idxArr.push(idx);
    await expect(idx.search('anything')).rejects.toMatchObject({
      code: ErrorCodes.INDEX_NOT_READY,
    });
  });

  it('persists index and loads it back', async () => {
    await mkfile('a.ts', 'hello world');
    const emb1 = new FakeEmbedder();
    const idx1 = await CodebaseIndex.create({
      workspaceRoot: tmpRoot,
      embedder: emb1,
      db,
      storePath,
    });
    idxArr.push(idx1);
    await idx1.reindex();
    const sizeAfter = idx1.size();
    expect(sizeAfter).toBeGreaterThan(0);

    // 新实例应该加载
    const emb2 = new FakeEmbedder();
    const idx2 = await CodebaseIndex.create({
      workspaceRoot: tmpRoot,
      embedder: emb2,
      db,
      storePath,
    });
    idxArr.push(idx2);
    expect(idx2.size()).toBe(sizeAfter);
    expect(emb2.calls).toBe(0); // 未触发重建
  });

  it('drops persisted index when model changes', async () => {
    await mkfile('a.ts', 'hello world');
    const idx1 = await CodebaseIndex.create({
      workspaceRoot: tmpRoot,
      embedder: new FakeEmbedder(),
      db,
      storePath,
    });
    idxArr.push(idx1);
    await idx1.reindex();

    // 换 modelId：直接构造另一个符合 Embedder 接口的对象
    const embV2: Embedder = {
      dimension: 3,
      modelId: 'fake-v2',
      async embed(inputs: string[]) {
        return { vectors: inputs.map(() => [1, 0, 0]) };
      },
    };
    const idx2 = await CodebaseIndex.create({
      workspaceRoot: tmpRoot,
      embedder: embV2,
      db,
      storePath,
    });
    idxArr.push(idx2);
    expect(idx2.size()).toBe(0);
  });

  it('emits progress callbacks', async () => {
    await mkfile('a.ts', 'hello');
    const phases: string[] = [];
    const idx = await CodebaseIndex.create({
      workspaceRoot: tmpRoot,
      embedder: new FakeEmbedder(),
      db,
      storePath,
      onProgress: (p) => {
        phases.push(p.phase);
      },
    });
    idxArr.push(idx);
    await idx.reindex();

    expect(phases).toContain('scanning');
    expect(phases).toContain('embedding');
    expect(phases).toContain('saving');
    expect(phases[phases.length - 1]).toBe('done');
  });

  it('aborts on signal', async () => {
    await mkfile('a.ts', 'hello');
    const ctl = new AbortController();
    ctl.abort();

    const idx = await CodebaseIndex.create({
      workspaceRoot: tmpRoot,
      embedder: new FakeEmbedder(),
      db,
      storePath,
      signal: ctl.signal,
    });
    idxArr.push(idx);
    await expect(idx.reindex()).rejects.toMatchObject({
      code: ErrorCodes.TASK_LOOP_ABORTED,
    });
  });

  it('listIndexedFiles returns unique file paths', async () => {
    await mkfile('a.ts', Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n'));
    await mkfile('b.ts', 'hello');
    const idx = await CodebaseIndex.create({
      workspaceRoot: tmpRoot,
      embedder: new FakeEmbedder(),
      db,
      storePath,
    });
    idxArr.push(idx);
    await idx.reindex();
    const files = idx.listIndexedFiles();
    expect(files.sort()).toEqual(['a.ts', 'b.ts']);
  });
});
