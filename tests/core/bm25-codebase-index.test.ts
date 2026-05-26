/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W13.4-C-1 · Bm25CodebaseIndex 单测
 *
 * 对齐 `tests/core/codebase-index.test.ts` 的覆盖范围（9 cases 同构）：
 *   - create 空库 size=0
 *   - reindex 命中文件数 / chunk 数 / duration 非零
 *   - search 空库抛 INDEX_NOT_READY
 *   - search 命中 + topK 截断
 *   - search 空 query 返回 []
 *   - updateFile 删除旧 + 插入新 chunks
 *   - removeFile 删除所有 chunks
 *   - save-load 往返一致（chunks 保持、search 仍可命中）
 *   - 损坏的 storePath → create 容错为空库
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import {
  Bm25CodebaseIndex,
  defaultBm25IndexStorePath,
} from '../../src/core/index/bm25-codebase-index.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

let tmpRoot: string;
let storePath: string;

async function mkfile(rel: string, content: string): Promise<void> {
  const abs = join(tmpRoot, rel);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'bm25-codebase-idx-'));
  storePath = join(tmpRoot, '.dualmind', 'bm25-index.json');
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('W13.4-C-1 · Bm25CodebaseIndex', () => {
  describe('create', () => {
    it('空工作区 → size=0', async () => {
      const idx = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      expect(idx.size()).toBe(0);
      expect(idx.listIndexedFiles()).toEqual([]);
    });

    it('损坏的 storePath → 容错为空库', async () => {
      await fs.mkdir(join(tmpRoot, '.dualmind'), { recursive: true });
      await fs.writeFile(storePath, '{invalid-json', 'utf-8');
      const idx = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      expect(idx.size()).toBe(0);
    });
  });

  describe('reindex', () => {
    it('扫描并入库 → filesScanned > 0, chunksEmbedded > 0, tokensUsed=0', async () => {
      await mkfile('src/auth.ts', 'function login(user: string) { return verifyPassword(user); }');
      await mkfile('src/utils.ts', 'export function verifyPassword(u: string) { return true; }');
      const idx = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      const stats = await idx.reindex();
      expect(stats.filesScanned).toBeGreaterThan(0);
      expect(stats.chunksEmbedded).toBeGreaterThan(0);
      expect(stats.tokensUsed).toBe(0); // BM25 零模型，无 tokens
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);
      expect(idx.size()).toBeGreaterThan(0);
    });

    it('reindex 后 listIndexedFiles 包含扫描到的文件', async () => {
      await mkfile('a.ts', 'const x = 1;');
      await mkfile('b.ts', 'const y = 2;');
      const idx = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      await idx.reindex();
      const files = idx.listIndexedFiles();
      expect(files.some((f) => f.endsWith('a.ts'))).toBe(true);
      expect(files.some((f) => f.endsWith('b.ts'))).toBe(true);
    });

    it('onProgress 回调依次触发 scanning → chunking → embedding → saving → done', async () => {
      await mkfile('x.ts', 'const v = 42;');
      const phases: string[] = [];
      const idx = await Bm25CodebaseIndex.create({
        workspaceRoot: tmpRoot,
        storePath,
        onProgress: (p) => phases.push(p.phase),
      });
      await idx.reindex();
      expect(phases).toContain('scanning');
      expect(phases).toContain('chunking');
      expect(phases).toContain('embedding');
      expect(phases).toContain('saving');
      expect(phases[phases.length - 1]).toBe('done');
    });
  });

  describe('search', () => {
    it('空库 → 抛 INDEX_NOT_READY', async () => {
      const idx = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      await expect(idx.search('anything')).rejects.toMatchObject({
        code: ErrorCodes.INDEX_NOT_READY,
      });
    });

    it('命中查询 → 返回 SearchResult[] 含 filePath/startLine/endLine/text/score', async () => {
      await mkfile(
        'src/login.ts',
        'function verifyPassword(password: string) { return password.length > 0; }',
      );
      await mkfile('src/unrelated.ts', 'const pi = 3.14;');
      const idx = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      await idx.reindex();

      const hits = await idx.search('verifyPassword');
      expect(hits.length).toBeGreaterThan(0);
      const top = hits[0];
      expect(top.filePath).toContain('login');
      expect(top.startLine).toBeGreaterThanOrEqual(1);
      expect(top.endLine).toBeGreaterThanOrEqual(top.startLine);
      expect(typeof top.text).toBe('string');
      expect(top.score).toBeGreaterThan(0);
    });

    it('topK 截断：传 2 → 最多返回 2 条', async () => {
      for (let i = 0; i < 5; i++) {
        await mkfile(`f${i}.ts`, `const target${i} = 'searchme';`);
      }
      const idx = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      await idx.reindex();
      const hits = await idx.search('searchme', 2);
      expect(hits.length).toBeLessThanOrEqual(2);
    });

    it('空 query → 返回 []（不抛 INDEX_NOT_READY）', async () => {
      await mkfile('a.ts', 'const x = 1;');
      const idx = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      await idx.reindex();
      expect(await idx.search('')).toEqual([]);
      expect(await idx.search('   ')).toEqual([]);
    });

    it('中文 query 能命中中文 chunk', async () => {
      await mkfile('src/zh.ts', '// 用户登录鉴权逻辑\nfunction loginCheck() { return true; }');
      await mkfile('src/en.ts', '// pure english comment');
      const idx = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      await idx.reindex();
      const hits = await idx.search('用户登录');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].filePath).toContain('zh');
    });
  });

  describe('updateFile', () => {
    it('修改文件 → 旧 chunks 被删，新内容可被搜到', async () => {
      await mkfile('src/target.ts', 'const oldKeyword = 1;');
      const idx = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      await idx.reindex();

      // 命中旧内容
      const oldHits = await idx.search('oldKeyword');
      expect(oldHits.length).toBeGreaterThan(0);

      // 改写文件并 updateFile
      await fs.writeFile(join(tmpRoot, 'src/target.ts'), 'const newKeyword = 2;', 'utf-8');
      const { removed, added } = await idx.updateFile('src/target.ts');
      expect(removed).toBeGreaterThan(0);
      expect(added).toBeGreaterThan(0);

      // 旧 keyword 不再命中，新 keyword 可命中
      await expect(idx.search('oldKeyword')).resolves.toEqual([]);
      const newHits = await idx.search('newKeyword');
      expect(newHits.length).toBeGreaterThan(0);
    });

    it('updateFile 目标文件已不可读 → 等价 removeFile', async () => {
      await mkfile('src/tmp.ts', 'const gone = 1;');
      const idx = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      await idx.reindex();
      await fs.rm(join(tmpRoot, 'src/tmp.ts'));

      const { removed, added } = await idx.updateFile('src/tmp.ts');
      expect(removed).toBeGreaterThan(0);
      expect(added).toBe(0);
    });
  });

  describe('removeFile', () => {
    it('删除某文件 → 该文件所有 chunks 被清', async () => {
      await mkfile('src/a.ts', 'const alpha = 1;');
      await mkfile('src/b.ts', 'const beta = 2;');
      const idx = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      await idx.reindex();
      const sizeBefore = idx.size();

      idx.removeFile('src/a.ts');
      expect(idx.size()).toBeLessThan(sizeBefore);
      await expect(idx.search('alpha')).resolves.toEqual([]);

      // b 文件仍在
      const hitsB = await idx.search('beta');
      expect(hitsB.length).toBeGreaterThan(0);
    });
  });

  describe('persistence', () => {
    it('save → reload：chunks 数量与检索能力一致', async () => {
      await mkfile('src/p.ts', 'function persistedFn() { return 42; }');
      const idx1 = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      await idx1.reindex();
      const size1 = idx1.size();
      const files1 = idx1.listIndexedFiles();

      // 重新 create 应自动 loadFromFile
      const idx2 = await Bm25CodebaseIndex.create({ workspaceRoot: tmpRoot, storePath });
      expect(idx2.size()).toBe(size1);
      expect(idx2.listIndexedFiles()).toEqual(files1);

      const hits = await idx2.search('persistedFn');
      expect(hits.length).toBeGreaterThan(0);
    });
  });

  describe('defaultBm25IndexStorePath', () => {
    it('默认路径在 workspaceRoot/.dualmind/bm25-index.json', () => {
      const p = defaultBm25IndexStorePath('/abs/workspace');
      expect(p).toMatch(/\.dualmind[\\/]bm25-index\.json$/);
    });
  });
});
