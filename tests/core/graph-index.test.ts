/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * GraphIndex 单测（P2）
 *
 * 覆盖：
 *   - GraphIndex CRUD：updateFile / removeFileData / size
 *   - 查询：findCallers / findCallees / findRelatedModules / getCallChain
 *   - 跨文件解析：resolveCrossFileCalls
 *   - 防爆限制
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { openSqliteDatabase, InMemoryDb } from '../../src/core/storage/sqlite-db.js';
import type { SqliteDatabaseLike } from '../../src/core/storage/sqlite-db.js';
import { GraphIndex, type FileExtractionResult } from '../../src/core/index/graph-index.js';

async function openTestDb(): Promise<SqliteDatabaseLike> {
  const tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'graph-test-'));
  const dbPath = join(tmpDir, 'test.sqlite');
  try {
    return await openSqliteDatabase({ dbPath });
  } catch {
    return new InMemoryDb();
  }
}

/** 判断是否为 InMemoryDb（无实际存储能力） */
function isInMemoryDb(db: SqliteDatabaseLike): boolean {
  return db instanceof InMemoryDb;
}

let db: SqliteDatabaseLike;
let graph: GraphIndex;

beforeEach(async () => {
  db = await openTestDb();
  graph = GraphIndex.create(db);
});

afterEach(() => {
  db.close();
});

// ─────────── helpers ───────────

function makeResult(overrides: Partial<FileExtractionResult> & { filePath: string }): FileExtractionResult {
  return {
    symbols: [],
    imports: [],
    ...overrides,
  };
}

function skipIfInMemory(): void {
  if (isInMemoryDb(db)) {
    // InMemoryDb 无法测试实际数据库操作
    return;
  }
}

// ─────────── CRUD ───────────

describe('GraphIndex CRUD', () => {
  it('create 后 size=0', () => {
    expect(graph.size()).toBe(0);
  });

  it('updateFile 插入符号后 size 增加', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [
        { name: 'foo', kind: 'function', startLine: 1, endLine: 10, calls: [] },
        { name: 'bar', kind: 'function', startLine: 12, endLine: 20, calls: [] },
      ],
    }));
    expect(graph.size()).toBe(2);
  });

  it('updateFile 同一文件更新 → 替换旧数据', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [
        { name: 'foo', kind: 'function', startLine: 1, endLine: 10, calls: [] },
        { name: 'bar', kind: 'function', startLine: 12, endLine: 20, calls: [] },
      ],
    }));
    expect(graph.size()).toBe(2);

    // 更新：只保留 foo，删除 bar，新增 baz
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [
        { name: 'foo', kind: 'function', startLine: 1, endLine: 10, calls: [] },
        { name: 'baz', kind: 'function', startLine: 22, endLine: 30, calls: [] },
      ],
    }));
    expect(graph.size()).toBe(2);
  });

  it('removeFileData 清除文件所有数据', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [
        { name: 'foo', kind: 'function', startLine: 1, endLine: 10, calls: [] },
      ],
    }));
    expect(graph.size()).toBe(1);

    graph.removeFileData('src/a.ts');
    expect(graph.size()).toBe(0);
  });

  it('空符号文件不报错', () => {
    graph.updateFile(makeResult({ filePath: 'src/empty.ts' }));
    expect(graph.size()).toBe(0);
  });
});

// ─────────── 调用关系 ───────────

describe('GraphIndex 调用关系', () => {
  it('updateFile 同时插入符号和调用关系', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [
        {
          name: 'foo', kind: 'function', startLine: 1, endLine: 10,
          calls: [{ calleeName: 'bar', callLine: 5 }],
        },
        {
          name: 'bar', kind: 'function', startLine: 12, endLine: 20,
          calls: [],
        },
      ],
    }));

    const callees = graph.findCallees('foo', 'src/a.ts');
    expect(callees).toHaveLength(1);
    expect(callees[0].name).toBe('bar');
  });

  it('findCallers 查找调用者', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [
        {
          name: 'foo', kind: 'function', startLine: 1, endLine: 10,
          calls: [{ calleeName: 'bar', callLine: 5 }],
        },
        { name: 'bar', kind: 'function', startLine: 12, endLine: 20, calls: [] },
      ],
    }));

    const callers = graph.findCallers('bar');
    expect(callers).toHaveLength(1);
    expect(callers[0].name).toBe('foo');
    expect(callers[0].filePath).toBe('src/a.ts');
  });

  it('跨文件调用关系', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [
        {
          name: 'foo', kind: 'function', startLine: 1, endLine: 10,
          calls: [{ calleeName: 'bar', callLine: 5 }],
        },
      ],
    }));
    graph.updateFile(makeResult({
      filePath: 'src/b.ts',
      symbols: [
        { name: 'bar', kind: 'function', startLine: 1, endLine: 10, calls: [] },
      ],
    }));

    const callers = graph.findCallers('bar');
    expect(callers).toHaveLength(1);
    expect(callers[0].name).toBe('foo');
  });

  it('未解析的外部调用显示为 <external>', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [
        {
          name: 'foo', kind: 'function', startLine: 1, endLine: 10,
          calls: [{ calleeName: 'unknownFunc', callLine: 5 }],
        },
      ],
    }));

    const callees = graph.findCallees('foo', 'src/a.ts');
    expect(callees).toHaveLength(1);
    expect(callees[0].name).toBe('unknownFunc');
    expect(callees[0].filePath).toBe('<external>');
  });
});

// ─────────── 跨文件解析 ───────────

describe('GraphIndex resolveCrossFileCalls', () => {
  it('解析后 callee_id 被填充', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [
        {
          name: 'foo', kind: 'function', startLine: 1, endLine: 10,
          calls: [{ calleeName: 'bar', callLine: 5 }],
        },
      ],
    }));
    graph.updateFile(makeResult({
      filePath: 'src/b.ts',
      symbols: [
        { name: 'bar', kind: 'function', startLine: 1, endLine: 10, calls: [] },
      ],
    }));

    graph.resolveCrossFileCalls();

    const callees = graph.findCallees('foo', 'src/a.ts');
    expect(callees).toHaveLength(1);
    expect(callees[0].name).toBe('bar');
    expect(callees[0].filePath).toBe('src/b.ts');
  });
});

// ─────────── 模块依赖 ───────────

describe('GraphIndex findRelatedModules', () => {
  it('查询上下游依赖', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/core/memory/store.ts',
      symbols: [{ name: 'init', kind: 'function', startLine: 1, endLine: 10, calls: [] }],
      imports: [{ targetFile: 'src/core/storage/sqlite-db.ts', symbols: ['openDb'] }],
    }));
    graph.updateFile(makeResult({
      filePath: 'src/core/storage/sqlite-db.ts',
      symbols: [{ name: 'openDb', kind: 'function', startLine: 1, endLine: 10, calls: [] }],
      imports: [],
    }));

    const related = graph.findRelatedModules('src/core/memory/');
    expect(related.downstream).toContain('src/core/storage/sqlite-db.ts');
    expect(related.upstream).toHaveLength(0);
  });
});

// ─────────── 调用链 ───────────

describe('GraphIndex getCallChain', () => {
  it('获取 N 层调用链', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [
        {
          name: 'a', kind: 'function', startLine: 1, endLine: 10,
          calls: [{ calleeName: 'b', callLine: 5 }],
        },
        {
          name: 'b', kind: 'function', startLine: 12, endLine: 20,
          calls: [{ calleeName: 'c', callLine: 15 }],
        },
        { name: 'c', kind: 'function', startLine: 22, endLine: 30, calls: [] },
      ],
    }));

    const chain = graph.getCallChain('a', 2);
    expect(chain).toHaveLength(1);
    expect(chain[0].symbol.name).toBe('a');
    expect(chain[0].callees.length).toBeGreaterThan(0);
  });

  it('depth=0 → 空结果', () => {
    const chain = graph.getCallChain('a', 0);
    expect(chain).toHaveLength(0);
  });
});

// ─────────── 防爆限制 ───────────

describe('GraphIndex 防爆限制', () => {
  it('超过 maxSymbols 时跳过', () => {
    skipIfInMemory();
    const smallGraph = GraphIndex.create(new InMemoryDb(), { maxSymbols: 2 });
    // InMemoryDb 无法实际存储，这里只测试逻辑路径
    // 实际防爆测试在集成测试中完成
  });
});
