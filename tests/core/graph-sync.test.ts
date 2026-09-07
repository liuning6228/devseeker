/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * GraphFileSync / buildGraphIndex 单测（P3 接线补全）
 *
 * 覆盖：
 *   - 增量：updateFile 读文件 → AST 提取 → 写图（真实 tree-sitter 提取）
 *   - 增量：修改后旧调用失效、新调用可查（caller 记录随文件替换）
 *   - 增量：文件不可读 → 等价删除
 *   - 删除：removeFile 清理该文件图数据
 *   - 全量：buildGraphIndex 多文件构建 + 跨文件 callee_id 解析
 *   - 全量：非代码文件 / 清单中缺失文件不阻断构建
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { openSqliteDatabase, InMemoryDb } from '../../src/core/storage/sqlite-db.js';
import type { SqliteDatabaseLike } from '../../src/core/storage/sqlite-db.js';
import { GraphIndex } from '../../src/core/index/graph-index.js';
import { GraphFileSync, buildGraphIndex } from '../../src/core/index/graph-sync.js';

// 与 graph-index.test.ts 同款：better-sqlite3 缺失时降级 InMemoryDb
async function openTestDb(): Promise<SqliteDatabaseLike> {
  const tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'graph-sync-'));
  const dbPath = join(tmpDir, 'test.sqlite');
  try {
    return await openSqliteDatabase({ dbPath });
  } catch {
    return new InMemoryDb();
  }
}

function isInMemoryDb(db: SqliteDatabaseLike): boolean {
  return db instanceof InMemoryDb;
}

let tmpRoot: string;
let db: SqliteDatabaseLike;
let graph: GraphIndex;

async function write(rel: string, content: string): Promise<void> {
  const abs = join(tmpRoot, rel);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'graph-sync-'));
  db = await openTestDb();
  graph = GraphIndex.create(db);
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
});

describe('GraphFileSync 增量更新', () => {
  it('updateFile 提取 TS 符号并写入图索引', async () => {
    if (isInMemoryDb(db)) return;
    await write('src/a.ts', 'export function alpha(): number { return 1; }');

    const sync = new GraphFileSync(graph, tmpRoot);
    const { added } = await sync.updateFile('src/a.ts');

    expect(added).toBe(1);
    expect(graph.size()).toBe(1);
  });

  it('跨文件调用在增量后自动解析（findCallers 命中调用方）', async () => {
    if (isInMemoryDb(db)) return;
    await write('src/a.ts', 'export function helper(): number { return 42; }');
    await write(
      'src/b.ts',
      "import { helper } from './a';\nexport function run(): number { return helper(); }",
    );

    const sync = new GraphFileSync(graph, tmpRoot);
    await sync.updateFile('src/a.ts');
    await sync.updateFile('src/b.ts');

    const callers = graph.findCallers('helper');
    expect(callers.some((c) => c.filePath === 'src/b.ts' && c.name === 'run')).toBe(true);
  });

  it('文件修改后旧调用失效、新调用可查', async () => {
    if (isInMemoryDb(db)) return;
    await write('src/a.ts', 'export function alpha(): number { return 1; }');
    await write(
      'src/b.ts',
      "import { alpha } from './a';\nexport function run(): number { return alpha(); }",
    );
    const sync = new GraphFileSync(graph, tmpRoot);
    await sync.updateFile('src/a.ts');
    await sync.updateFile('src/b.ts');
    expect(graph.findCallers('alpha').some((c) => c.filePath === 'src/b.ts')).toBe(true);

    // 模拟开发进展：a 定义改为 beta，b 改用 beta
    await write('src/a.ts', 'export function beta(): number { return 2; }');
    await write(
      'src/b.ts',
      "import { beta } from './a';\nexport function run(): number { return beta(); }",
    );
    await sync.updateFile('src/a.ts');
    await sync.updateFile('src/b.ts');

    expect(graph.findCallers('beta').some((c) => c.filePath === 'src/b.ts')).toBe(true);
    expect(graph.findCallers('alpha')).toEqual([]);
  });

  it('updateFile 时文件不可读 → 等价删除', async () => {
    if (isInMemoryDb(db)) return;
    await write('src/a.ts', 'export function alpha(): number { return 1; }');
    const sync = new GraphFileSync(graph, tmpRoot);
    await sync.updateFile('src/a.ts');
    expect(graph.size()).toBe(1);

    await fs.unlink(join(tmpRoot, 'src/a.ts'));
    const { removed, added } = await sync.updateFile('src/a.ts');

    expect(removed).toBe(0);
    expect(added).toBe(0);
    expect(graph.size()).toBe(0);
  });

  it('removeFile 清理该文件的全部图数据', async () => {
    if (isInMemoryDb(db)) return;
    await write('src/a.ts', 'export function alpha(): number { return 1; }');
    await write('src/b.ts', 'export function beta(): number { return 2; }');
    const sync = new GraphFileSync(graph, tmpRoot);
    await sync.updateFile('src/a.ts');
    await sync.updateFile('src/b.ts');
    expect(graph.size()).toBe(2);

    sync.removeFile('src/a.ts');

    expect(graph.size()).toBe(1);
    expect(graph.findCallers('alpha')).toEqual([]);
  });
});

describe('buildGraphIndex 全量构建', () => {
  it('多文件构建 + 跨文件 callee_id 解析', async () => {
    if (isInMemoryDb(db)) return;
    await write('src/a.ts', 'export function helper(): number { return 42; }');
    await write(
      'src/b.ts',
      "import { helper } from './a';\nexport function run(): number { return helper(); }",
    );
    await write('README.md', '# 仅文档，无符号');

    const stats = await buildGraphIndex(graph, tmpRoot, [
      'src/a.ts',
      'src/b.ts',
      'README.md',
    ]);

    expect(stats.filesProcessed).toBe(3);
    expect(stats.filesWithSymbols).toBe(2);
    expect(stats.symbols).toBe(2);
    expect(graph.findCallers('helper').some((c) => c.filePath === 'src/b.ts')).toBe(true);
  });

  it('清单中缺失文件跳过，不阻断其余文件', async () => {
    if (isInMemoryDb(db)) return;
    await write('src/a.ts', 'export function alpha(): number { return 1; }');

    const stats = await buildGraphIndex(graph, tmpRoot, [
      'src/missing.ts',
      'src/a.ts',
    ]);

    expect(stats.filesProcessed).toBe(2);
    expect(stats.filesWithSymbols).toBe(1);
    expect(graph.size()).toBe(1);
  });

  it('空清单 → 零处理、零符号', async () => {
    if (isInMemoryDb(db)) return;
    const stats = await buildGraphIndex(graph, tmpRoot, []);
    expect(stats.filesProcessed).toBe(0);
    expect(stats.symbols).toBe(0);
  });
});