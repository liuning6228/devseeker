/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-1.0.1-A · auto-indexer 单测
 *
 * 覆盖 6 条关键路径：
 *  1) 无工作区 → 跳过
 *  2) 有工作区但无项目标识 → 跳过
 *  3) 24h 内已跑过 → 跳过
 *  4) API Key 缺失（buildEmbedder 返回 undefined） → 跳过
 *  5) 已有持久化索引（idx.size() > 0） → 跳过 reindex 但更新 marker
 *  6) 首次完全满足 → 调用 createIndex + reindex，更新 marker
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  maybeAutoReindex,
  anyMarkerExists,
  AUTO_INDEX_MARKER_KEY,
  AUTO_INDEX_RERUN_MS,
  type AutoIndexerDeps,
} from '../../src/core/index/auto-indexer.js';
import type { Embedder, EmbedResult } from '../../src/core/index/embedder.js';

/** 最简 fake logger：吞掉所有调用。 */
const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => fakeLogger,
  level: 'info',
} as unknown as AutoIndexerDeps['log'];

/** 最简 fake embedder：只满足 Embedder 接口。 */
const fakeEmbedder: Embedder = {
  dimension: 3,
  modelId: 'fake-v1',
  async embed(inputs: string[]): Promise<EmbedResult> {
    return { vectors: inputs.map(() => [0, 0, 0]), totalTokens: 0 };
  },
};

/** 构造内存版 workspaceState（读写同一对象）。 */
function makeFakeContext(initial: Record<string, unknown> = {}): AutoIndexerDeps['context'] {
  const store = new Map(Object.entries(initial));
  return {
    workspaceState: {
      get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
      update: (key: string, value: unknown): Thenable<void> => {
        store.set(key, value);
        return Promise.resolve();
      },
      keys: () => Array.from(store.keys()),
    },
  } as unknown as AutoIndexerDeps['context'];
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'autoidx-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('anyMarkerExists', () => {
  it('returns true when package.json exists', async () => {
    await fs.writeFile(join(tmpRoot, 'package.json'), '{}', 'utf-8');
    expect(await anyMarkerExists(tmpRoot)).toBe(true);
  });

  it('returns true when pyproject.toml exists', async () => {
    await fs.writeFile(join(tmpRoot, 'pyproject.toml'), '', 'utf-8');
    expect(await anyMarkerExists(tmpRoot)).toBe(true);
  });

  it('returns false for empty directory', async () => {
    expect(await anyMarkerExists(tmpRoot)).toBe(false);
  });

  it('returns false for non-project files only', async () => {
    await fs.writeFile(join(tmpRoot, 'README.md'), '', 'utf-8');
    await fs.writeFile(join(tmpRoot, 'notes.txt'), '', 'utf-8');
    expect(await anyMarkerExists(tmpRoot)).toBe(false);
  });
});

describe('maybeAutoReindex', () => {
  it('skips when no workspace folder', async () => {
    const ctx = makeFakeContext();
    const outcome = await maybeAutoReindex({
      context: ctx,
      log: fakeLogger,
      workspaceRoot: undefined,
      schedule: null, // sync
    });
    expect(outcome).toBe('no-workspace');
  });

  it('skips when workspace has no project marker', async () => {
    await fs.writeFile(join(tmpRoot, 'README.md'), '', 'utf-8');
    const ctx = makeFakeContext();
    const outcome = await maybeAutoReindex({
      context: ctx,
      log: fakeLogger,
      workspaceRoot: tmpRoot,
      schedule: null,
    });
    expect(outcome).toBe('no-project-marker');
  });

  it('skips when last run is within 24h', async () => {
    await fs.writeFile(join(tmpRoot, 'package.json'), '{}', 'utf-8');
    const now = 10_000_000;
    const ctx = makeFakeContext({
      [AUTO_INDEX_MARKER_KEY]: now - (AUTO_INDEX_RERUN_MS - 1_000), // 23h59m ago
    });
    const outcome = await maybeAutoReindex({
      context: ctx,
      log: fakeLogger,
      workspaceRoot: tmpRoot,
      now: () => now,
      schedule: null,
    });
    expect(outcome).toBe('recently-ran');
  });

  it('skips when buildEmbedder returns undefined (no API key)', async () => {
    await fs.writeFile(join(tmpRoot, 'go.mod'), 'module x\n', 'utf-8');
    const ctx = makeFakeContext();
    const outcome = await maybeAutoReindex({
      context: ctx,
      log: fakeLogger,
      workspaceRoot: tmpRoot,
      buildEmbedder: () => undefined,
      schedule: null,
    });
    expect(outcome).toBe('no-api-key');
  });

  it('reuses existing index (size > 0) without reindexing, but updates marker', async () => {
    await fs.writeFile(join(tmpRoot, 'Cargo.toml'), '[package]\n', 'utf-8');
    const ctx = makeFakeContext();
    let reindexCalled = false;

    const outcome = await maybeAutoReindex({
      context: ctx,
      log: fakeLogger,
      workspaceRoot: tmpRoot,
      buildEmbedder: () => fakeEmbedder,
      createIndex: async () =>
        ({
          size: () => 42, // 非空索引
          reindex: async () => {
            reindexCalled = true;
            return {
              filesScanned: 0,
              filesSkippedLarge: 0,
              filesSkippedExt: 0,
              chunksEmbedded: 0,
              tokensUsed: 0,
              durationMs: 0,
              filterSamples: [],
            };
          },
        }) as never,
      now: () => 12345,
      schedule: null,
    });

    expect(outcome).toBe('already-populated');
    expect(reindexCalled).toBe(false);
    expect(ctx.workspaceState.get<number>(AUTO_INDEX_MARKER_KEY)).toBe(12345);
  });

  it('runs reindex on first time, updates marker with now()', async () => {
    await fs.writeFile(join(tmpRoot, 'tsconfig.json'), '{}', 'utf-8');
    const ctx = makeFakeContext();
    let reindexCalled = false;

    const outcome = await maybeAutoReindex({
      context: ctx,
      log: fakeLogger,
      workspaceRoot: tmpRoot,
      buildEmbedder: () => fakeEmbedder,
      createIndex: async () =>
        ({
          size: () => 0, // 空索引 → 触发 reindex
          reindex: async () => {
            reindexCalled = true;
            return {
              filesScanned: 5,
              filesSkippedLarge: 0,
              filesSkippedExt: 0,
              chunksEmbedded: 10,
              tokensUsed: 100,
              durationMs: 50,
              filterSamples: [],
            };
          },
        }) as never,
      now: () => 99999,
      schedule: null,
    });

    expect(outcome).toBe('reindexed');
    expect(reindexCalled).toBe(true);
    expect(ctx.workspaceState.get<number>(AUTO_INDEX_MARKER_KEY)).toBe(99999);
  });

  it('returns reindex-failed on exception without throwing', async () => {
    await fs.writeFile(join(tmpRoot, 'pom.xml'), '<project/>', 'utf-8');
    const ctx = makeFakeContext();

    const outcome = await maybeAutoReindex({
      context: ctx,
      log: fakeLogger,
      workspaceRoot: tmpRoot,
      buildEmbedder: () => fakeEmbedder,
      createIndex: async () => {
        throw new Error('boom');
      },
      now: () => 1,
      schedule: null,
    });

    expect(outcome).toBe('reindex-failed');
    // marker 不应该被更新（失败时保留下次重试能力）
    expect(ctx.workspaceState.get<number>(AUTO_INDEX_MARKER_KEY)).toBeUndefined();
  });

  // B-1.0.1-C · 0 files 时打诊断 warn 日志
  it('logs diagnostic warn with filterSamples when reindex returns filesScanned=0', async () => {
    await fs.writeFile(join(tmpRoot, 'package.json'), '{}', 'utf-8');
    const ctx = makeFakeContext();
    const warnCalls: Array<{ obj: unknown; msg: string }> = [];
    const capturingLogger = {
      info: () => {},
      warn: (obj: unknown, msg: string) => {
        warnCalls.push({ obj, msg });
      },
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child: () => capturingLogger,
      level: 'info',
    } as unknown as AutoIndexerDeps['log'];

    const outcome = await maybeAutoReindex({
      context: ctx,
      log: capturingLogger,
      workspaceRoot: tmpRoot,
      buildEmbedder: () => fakeEmbedder,
      createIndex: async () =>
        ({
          size: () => 0,
          reindex: async () => ({
            filesScanned: 0,
            filesSkippedLarge: 0,
            filesSkippedExt: 12,
            chunksEmbedded: 0,
            tokensUsed: 0,
            durationMs: 20,
            filterSamples: [
              { relPath: 'a.zip', reason: 'ext-not-whitelisted', detail: '.zip' },
              { relPath: 'b.msi', reason: 'ext-not-whitelisted', detail: '.msi' },
              { relPath: 'node_modules', reason: 'ignored-dir', detail: 'node_modules' },
            ],
          }),
        }) as never,
      now: () => 77,
      schedule: null,
    });

    expect(outcome).toBe('reindexed');
    // 必须有至少一条 warn 记录，且包含 filterSamples
    const hit = warnCalls.find((c) => typeof c.msg === 'string' && c.msg.includes('0 files'));
    expect(hit).toBeDefined();
    const payload = hit!.obj as { filterSamples: unknown[] };
    expect(Array.isArray(payload.filterSamples)).toBe(true);
    expect(payload.filterSamples.length).toBe(3);
  });

  // B-1.0.1-D · onStateChange 回调在关键节点完整流转
  it('fires onStateChange indexing → ready when reindex succeeds', async () => {
    await fs.writeFile(join(tmpRoot, 'go.mod'), 'module x\n', 'utf-8');
    const ctx = makeFakeContext();
    const states: Array<{ s: string; fc?: number }> = [];

    const outcome = await maybeAutoReindex({
      context: ctx,
      log: fakeLogger,
      workspaceRoot: tmpRoot,
      buildEmbedder: () => fakeEmbedder,
      createIndex: async () =>
        ({
          size: () => 0,
          reindex: async () => ({
            filesScanned: 7,
            filesSkippedLarge: 0,
            filesSkippedExt: 0,
            chunksEmbedded: 14,
            tokensUsed: 100,
            durationMs: 30,
            filterSamples: [],
          }),
        }) as never,
      now: () => 1,
      schedule: null,
      onStateChange: (s, info) => states.push({ s, fc: info?.fileCount }),
    });

    expect(outcome).toBe('reindexed');
    // 至少包含 indexing 和 ready 两种状态
    expect(states.some((x) => x.s === 'indexing')).toBe(true);
    const readyHit = states.find((x) => x.s === 'ready');
    expect(readyHit).toBeDefined();
    expect(readyHit?.fc).toBe(7);
  });

  it('fires onStateChange empty when reindex returns filesScanned=0', async () => {
    await fs.writeFile(join(tmpRoot, 'tsconfig.json'), '{}', 'utf-8');
    const ctx = makeFakeContext();
    const states: Array<{ s: string }> = [];

    await maybeAutoReindex({
      context: ctx,
      log: fakeLogger,
      workspaceRoot: tmpRoot,
      buildEmbedder: () => fakeEmbedder,
      createIndex: async () =>
        ({
          size: () => 0,
          reindex: async () => ({
            filesScanned: 0,
            filesSkippedLarge: 0,
            filesSkippedExt: 5,
            chunksEmbedded: 0,
            tokensUsed: 0,
            durationMs: 10,
            filterSamples: [],
          }),
        }) as never,
      now: () => 2,
      schedule: null,
      onStateChange: (s) => states.push({ s }),
    });

    expect(states.some((x) => x.s === 'empty')).toBe(true);
  });

  it('fires onStateChange error on reindex exception', async () => {
    await fs.writeFile(join(tmpRoot, 'pom.xml'), '<project/>', 'utf-8');
    const ctx = makeFakeContext();
    const states: Array<{ s: string }> = [];

    await maybeAutoReindex({
      context: ctx,
      log: fakeLogger,
      workspaceRoot: tmpRoot,
      buildEmbedder: () => fakeEmbedder,
      createIndex: async () => {
        throw new Error('kaboom');
      },
      now: () => 3,
      schedule: null,
      onStateChange: (s) => states.push({ s }),
    });

    expect(states.some((x) => x.s === 'error')).toBe(true);
  });
});

// W13.4-C-2 · BM25 provider 分支：完全绕过 embedder / createIndex，走 createBm25Index 路径
describe('maybeAutoReindex · BM25 provider', () => {
  let origGetConfiguration: typeof vscode.workspace.getConfiguration;

  beforeEach(() => {
    origGetConfiguration = vscode.workspace.getConfiguration;
    // 覆写 mock：让 provider 读到 'bm25'
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
      get: <T>(k: string, def?: T): T | undefined => {
        if (k === 'codebaseIndex.embedProvider') return 'bm25' as unknown as T;
        return def;
      },
    });
  });

  afterEach(() => {
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration =
      origGetConfiguration;
  });

  it('bypasses buildEmbedder entirely when provider=bm25', async () => {
    await fs.writeFile(join(tmpRoot, 'package.json'), '{}', 'utf-8');
    const ctx = makeFakeContext();
    let buildEmbedderCalled = false;
    let createBm25Called = false;

    const outcome = await maybeAutoReindex({
      context: ctx,
      log: fakeLogger,
      workspaceRoot: tmpRoot,
      buildEmbedder: () => {
        buildEmbedderCalled = true;
        return fakeEmbedder;
      },
      createBm25Index: async () => {
        createBm25Called = true;
        return {
          size: () => 0,
          listIndexedFiles: () => [],
          reindex: async () => ({
            filesScanned: 3,
            filesSkippedLarge: 0,
            filesSkippedExt: 0,
            chunksEmbedded: 9,
            tokensUsed: 0,
            durationMs: 15,
            filterSamples: [],
          }),
        } as never;
      },
      now: () => 111,
      schedule: null,
    });

    expect(outcome).toBe('reindexed');
    expect(buildEmbedderCalled).toBe(false);
    expect(createBm25Called).toBe(true);
    expect(ctx.workspaceState.get<number>(AUTO_INDEX_MARKER_KEY)).toBe(111);
  });

  it('bm25: reuses existing index when size > 0', async () => {
    await fs.writeFile(join(tmpRoot, 'Cargo.toml'), '[package]\n', 'utf-8');
    const ctx = makeFakeContext();
    let reindexCalled = false;

    const outcome = await maybeAutoReindex({
      context: ctx,
      log: fakeLogger,
      workspaceRoot: tmpRoot,
      createBm25Index: async () =>
        ({
          size: () => 17,
          listIndexedFiles: () => ['a.ts', 'b.ts'],
          reindex: async () => {
            reindexCalled = true;
            return {
              filesScanned: 0,
              filesSkippedLarge: 0,
              filesSkippedExt: 0,
              chunksEmbedded: 0,
              tokensUsed: 0,
              durationMs: 0,
              filterSamples: [],
            };
          },
        }) as never,
      now: () => 222,
      schedule: null,
    });

    expect(outcome).toBe('already-populated');
    expect(reindexCalled).toBe(false);
    expect(ctx.workspaceState.get<number>(AUTO_INDEX_MARKER_KEY)).toBe(222);
  });

  it('bm25: returns reindex-failed on createBm25Index exception', async () => {
    await fs.writeFile(join(tmpRoot, 'go.mod'), 'module x\n', 'utf-8');
    const ctx = makeFakeContext();
    const states: Array<{ s: string }> = [];

    const outcome = await maybeAutoReindex({
      context: ctx,
      log: fakeLogger,
      workspaceRoot: tmpRoot,
      createBm25Index: async () => {
        throw new Error('bm25-boom');
      },
      now: () => 333,
      schedule: null,
      onStateChange: (s) => states.push({ s }),
    });

    expect(outcome).toBe('reindex-failed');
    expect(states.some((x) => x.s === 'error')).toBe(true);
    // marker 失败时不更新，保留下次重试能力
    expect(ctx.workspaceState.get<number>(AUTO_INDEX_MARKER_KEY)).toBeUndefined();
  });
});
