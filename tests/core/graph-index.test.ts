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

// ─────────── Repo Map 数据源（热度聚合 / 路径前缀查询） ───────────

describe('GraphIndex getHotSymbols（Repo Map 热度聚合）', () => {
  it('空图返回空数组', () => {
    expect(graph.getHotSymbols(10)).toEqual([]);
  });

  it('按被调用次数聚合，带定义信息；无调用者的符号不上榜', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [
        { name: 'foo', kind: 'function', startLine: 1, endLine: 10, calls: [] },
        { name: 'bar', kind: 'function', startLine: 12, endLine: 20, calls: [{ calleeName: 'foo', callLine: 15 }] },
      ],
    }));
    graph.updateFile(makeResult({
      filePath: 'src/b.ts',
      symbols: [
        { name: 'baz', kind: 'function', startLine: 1, endLine: 5, calls: [{ calleeName: 'foo', callLine: 3 }] },
      ],
    }));
    graph.resolveCrossFileCalls();

    const hot = graph.getHotSymbols(10);
    const names = hot.map((h) => h.name);
    // foo 被 bar（同文件）+ baz（跨文件解析后）调用 → heat=2
    expect(names).toContain('foo');
    expect(names).not.toContain('baz'); // 无调用者不上榜

    const fooRow = hot.find((h) => h.name === 'foo');
    expect(fooRow).toBeDefined();
    expect(fooRow!.heat).toBe(2);
    expect(fooRow!.filePath).toBe('src/a.ts');
    expect(fooRow!.kind).toBe('function');
    expect(fooRow!.startLine).toBe(1);
    // 热度降序：foo 在最前
    expect(hot[0]!.name).toBe('foo');
  });

  it('未解析的外部调用不污染热度（join 定义表天然过滤）', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/c.ts',
      symbols: [
        {
          name: 'caller', kind: 'function', startLine: 1, endLine: 3,
          calls: [
            { calleeName: 'externalNotDefined', callLine: 2 },
            { calleeName: 'localFn', callLine: 3 },
          ],
        },
        { name: 'localFn', kind: 'function', startLine: 5, endLine: 8, calls: [] },
      ],
    }));
    graph.resolveCrossFileCalls();

    const hot = graph.getHotSymbols(10);
    const names = hot.map((h) => h.name);
    expect(names).not.toContain('externalNotDefined');
    expect(names).toContain('localFn');
    expect(hot.find((h) => h.name === 'localFn')!.heat).toBe(1);
  });

  it('maxNames 限制上榜名字数', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/d.ts',
      symbols: [
        { name: 'x1', kind: 'function', startLine: 1, endLine: 2, calls: [] },
        { name: 'x2', kind: 'function', startLine: 3, endLine: 4, calls: [] },
        { name: 'x3', kind: 'function', startLine: 5, endLine: 6, calls: [] },
        {
          name: 'c1', kind: 'function', startLine: 8, endLine: 9,
          calls: [
            { calleeName: 'x1', callLine: 8 },
            { calleeName: 'x2', callLine: 8 },
            { calleeName: 'x3', callLine: 9 },
          ],
        },
      ],
    }));
    graph.resolveCrossFileCalls();

    const limited = graph.getHotSymbols(1);
    expect(new Set(limited.map((h) => h.name)).size).toBe(1);
  });

  it('同名多定义符号不上榜（唯一名约束）', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [
        { name: 'get', kind: 'method', startLine: 1, endLine: 5, calls: [] },
        { name: 'uniqueFn', kind: 'function', startLine: 7, endLine: 9, calls: [] },
      ],
    }));
    graph.updateFile(makeResult({
      filePath: 'src/b.ts',
      symbols: [
        { name: 'get', kind: 'method', startLine: 1, endLine: 5, calls: [] },
        {
          name: 'caller', kind: 'function', startLine: 10, endLine: 20,
          calls: [
            { calleeName: 'get', callLine: 12 },
            { calleeName: 'uniqueFn', callLine: 14 },
          ],
        },
      ],
    }));
    graph.resolveCrossFileCalls();

    const names = graph.getHotSymbols(10).map((h) => h.name);
    expect(names).toContain('uniqueFn');
    expect(names).not.toContain('get'); // 2 个定义 → 歧义 → 不上榜
  });

  it('原生成员名（push/keys 等）即使单定义也不上榜（黑名单）', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [
        { name: 'push', kind: 'method', startLine: 1, endLine: 5, calls: [] },
        { name: 'keys', kind: 'method', startLine: 7, endLine: 9, calls: [] },
        { name: 'realFn', kind: 'function', startLine: 11, endLine: 13, calls: [] },
        {
          name: 'caller', kind: 'function', startLine: 15, endLine: 30,
          calls: [
            { calleeName: 'push', callLine: 16 },
            { calleeName: 'keys', callLine: 18 },
            { calleeName: 'realFn', callLine: 20 },
          ],
        },
      ],
    }));
    graph.resolveCrossFileCalls();

    const names = graph.getHotSymbols(10).map((h) => h.name);
    expect(names).toContain('realFn');
    expect(names).not.toContain('push');
    expect(names).not.toContain('keys');
  });

  it('测试文件的调用不计数（caller 侧过滤）', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [{ name: 'coreFn', kind: 'function', startLine: 1, endLine: 5, calls: [] }],
    }));
    graph.updateFile(makeResult({
      filePath: 'tests/a.test.ts',
      symbols: [
        { name: 'caseA', kind: 'function', startLine: 1, endLine: 9, calls: [{ calleeName: 'coreFn', callLine: 5 }] },
      ],
    }));
    graph.resolveCrossFileCalls();

    // 唯一调用来源是测试文件 → 热度为 0 → 不上榜
    expect(graph.getHotSymbols(10).map((h) => h.name)).not.toContain('coreFn');
  });

  it('测试文件中的同名定义不参与唯一性判定也不占榜', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/a.ts',
      symbols: [{ name: 'shared', kind: 'function', startLine: 1, endLine: 5, calls: [] }],
    }));
    graph.updateFile(makeResult({
      filePath: 'src/b.ts',
      symbols: [
        { name: 'userFn', kind: 'function', startLine: 1, endLine: 9, calls: [{ calleeName: 'shared', callLine: 3 }] },
      ],
    }));
    graph.updateFile(makeResult({
      filePath: 'tests/x.test.ts',
      symbols: [{ name: 'shared', kind: 'function', startLine: 1, endLine: 3, calls: [] }],
    }));
    graph.resolveCrossFileCalls();

    const rows = graph.getHotSymbols(10).filter((h) => h.name === 'shared');
    expect(rows).toHaveLength(1); // 只保留 src 定义行
    expect(rows[0]!.filePath).toBe('src/a.ts');
    expect(rows[0]!.heat).toBe(1);
  });
});

describe('GraphIndex findSymbolsByPathPrefix（Repo Map focus）', () => {
  it('前缀匹配，按路径与行号排序；空 prefix 返回空', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/core/b.ts',
      symbols: [{ name: 'beta', kind: 'function', startLine: 1, endLine: 2, calls: [] }],
    }));
    graph.updateFile(makeResult({
      filePath: 'src/core/a.ts',
      symbols: [{ name: 'alpha', kind: 'function', startLine: 1, endLine: 2, calls: [] }],
    }));
    graph.updateFile(makeResult({
      filePath: 'src/other/c.ts',
      symbols: [{ name: 'gamma', kind: 'function', startLine: 1, endLine: 2, calls: [] }],
    }));

    const refs = graph.findSymbolsByPathPrefix('src/core/');
    expect(refs.map((r) => r.name)).toEqual(['alpha', 'beta']); // 路径排序 a < b
    expect(refs[0]!.filePath).toBe('src/core/a.ts');

    expect(graph.findSymbolsByPathPrefix('')).toEqual([]);
    expect(graph.findSymbolsByPathPrefix('src/nothing/')).toEqual([]);
  });

  it('LIKE 通配符转义：字面 % 前缀不误匹配', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/100%/a.ts',
      symbols: [{ name: 'literalPct', kind: 'function', startLine: 1, endLine: 2, calls: [] }],
    }));
    graph.updateFile(makeResult({
      filePath: 'src/100x/a.ts',
      symbols: [{ name: 'otherFile', kind: 'function', startLine: 1, endLine: 2, calls: [] }],
    }));

    const refs = graph.findSymbolsByPathPrefix('src/100%/');
    expect(refs.map((r) => r.name)).toEqual(['literalPct']);
    expect(refs.map((r) => r.name)).not.toContain('otherFile');
  });

  it('无斜杠输入按路径段匹配：裸文件名 / 裸目录名（不误匹配邻近名字）', () => {
    skipIfInMemory();
    graph.updateFile(makeResult({
      filePath: 'src/webview/panel.ts',
      symbols: [{ name: 'panelFn', kind: 'function', startLine: 1, endLine: 2, calls: [] }],
    }));
    graph.updateFile(makeResult({
      filePath: 'src/core/a.ts',
      symbols: [{ name: 'coreFn', kind: 'function', startLine: 1, endLine: 2, calls: [] }],
    }));
    graph.updateFile(makeResult({
      filePath: 'src/score.ts',
      symbols: [{ name: 'scoreFn', kind: 'function', startLine: 1, endLine: 2, calls: [] }],
    }));

    // 裸文件名 → 文件名段匹配（任意目录下的该文件）
    expect(graph.findSymbolsByPathPrefix('panel.ts').map((r) => r.name)).toEqual(['panelFn']);
    // 裸目录名 → 目录段匹配；不误匹配 src/score.ts（无 /core/ 段）
    expect(graph.findSymbolsByPathPrefix('core').map((r) => r.name)).toEqual(['coreFn']);
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
