/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * scanWorkspace 单测
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { scanWorkspace } from '../../src/core/index/scanner.js';

let tmpRoot: string;

async function mkfile(rel: string, content = '// hi'): Promise<void> {
  const abs = join(tmpRoot, rel);
  await fs.mkdir(resolve(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'scanner-'));
});

afterEach(async () => {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('scanWorkspace', () => {
  it('returns empty for empty directory', async () => {
    const r = await scanWorkspace(tmpRoot);
    expect(r.files).toEqual([]);
  });

  it('finds source files with whitelisted extensions', async () => {
    await mkfile('a.ts', 'export const a = 1;');
    await mkfile('src/b.tsx', 'export const b = 2;');
    await mkfile('README.md', '# hi');

    const r = await scanWorkspace(tmpRoot);
    const rels = r.files.map((f) => f.relPath).sort();
    expect(rels).toEqual(['README.md', 'a.ts', 'src/b.tsx']);
  });

  it('skips default ignore directories', async () => {
    await mkfile('a.ts');
    await mkfile('node_modules/pkg/index.js');
    await mkfile('.git/HEAD');
    await mkfile('dist/out.js');

    const r = await scanWorkspace(tmpRoot);
    const rels = r.files.map((f) => f.relPath);
    expect(rels).toEqual(['a.ts']);
  });

  it('skips files not in include extension list', async () => {
    await mkfile('a.ts');
    await mkfile('binary.png', 'not really png');
    await mkfile('docs.pdf', 'not really pdf');

    const r = await scanWorkspace(tmpRoot);
    expect(r.files.map((f) => f.relPath)).toEqual(['a.ts']);
    expect(r.skippedExt).toBeGreaterThanOrEqual(2);
  });

  it('skips files larger than maxFileSize', async () => {
    await mkfile('small.ts', 'a'.repeat(100));
    await mkfile('big.ts', 'a'.repeat(5000));

    const r = await scanWorkspace(tmpRoot, { maxFileSize: 1000 });
    expect(r.files.map((f) => f.relPath)).toEqual(['small.ts']);
    expect(r.skippedLarge).toBe(1);
  });

  it('respects extraIgnoreDirs', async () => {
    await mkfile('a.ts');
    await mkfile('secret/b.ts');

    const r = await scanWorkspace(tmpRoot, { extraIgnoreDirs: ['secret'] });
    expect(r.files.map((f) => f.relPath)).toEqual(['a.ts']);
  });

  it('respects extraIncludeExt', async () => {
    await mkfile('a.ts');
    await mkfile('b.sql', 'SELECT 1');

    const r = await scanWorkspace(tmpRoot, { extraIncludeExt: ['.sql'] });
    const rels = r.files.map((f) => f.relPath).sort();
    expect(rels).toEqual(['a.ts', 'b.sql']);
  });

  it('respects maxFiles cap', async () => {
    for (let i = 0; i < 20; i++) {
      await mkfile(`f${i}.ts`);
    }
    const r = await scanWorkspace(tmpRoot, { maxFiles: 5 });
    expect(r.files.length).toBeLessThanOrEqual(5);
  });

  it('returns POSIX-style relative paths', async () => {
    await mkfile('a/b/c.ts');
    const r = await scanWorkspace(tmpRoot);
    expect(r.files[0].relPath).toBe('a/b/c.ts');
  });

  it('populates size and mtimeMs', async () => {
    await mkfile('a.ts', 'hello');
    const r = await scanWorkspace(tmpRoot);
    expect(r.files[0].size).toBe(5);
    expect(r.files[0].mtimeMs).toBeGreaterThan(0);
  });

  // B-1.0.1-C · 被过滤条目采样
  describe('filterSamples (B-1.0.1-C)', () => {
    it('returns empty filterSamples on truly empty workspace', async () => {
      const r = await scanWorkspace(tmpRoot);
      expect(r.filterSamples).toEqual([]);
    });

    it('samples ext-not-whitelisted files', async () => {
      await mkfile('a.zip');
      await mkfile('b.exe');
      await mkfile('c.msi');
      const r = await scanWorkspace(tmpRoot);
      expect(r.files).toHaveLength(0);
      expect(r.filterSamples.length).toBe(3);
      for (const s of r.filterSamples) {
        expect(s.reason).toBe('ext-not-whitelisted');
      }
      const exts = r.filterSamples.map((s) => s.detail);
      expect(exts).toContain('.zip');
      expect(exts).toContain('.exe');
      expect(exts).toContain('.msi');
    });

    it('samples ignored-dir', async () => {
      await mkfile('node_modules/pkg/index.js');
      await mkfile('dist/bundle.js');
      const r = await scanWorkspace(tmpRoot);
      const reasons = r.filterSamples.map((s) => s.reason);
      expect(reasons).toContain('ignored-dir');
      const details = r.filterSamples
        .filter((s) => s.reason === 'ignored-dir')
        .map((s) => s.detail);
      expect(details).toContain('node_modules');
      expect(details).toContain('dist');
    });

    it('samples too-large files', async () => {
      const big = 'x'.repeat(200);
      await mkfile('big.ts', big);
      const r = await scanWorkspace(tmpRoot, { maxFileSize: 100 });
      expect(r.files).toHaveLength(0);
      expect(r.filterSamples.length).toBeGreaterThan(0);
      expect(r.filterSamples[0].reason).toBe('too-large');
      expect(r.filterSamples[0].detail).toMatch(/KB/);
    });

    it('caps total samples at 10 with per-reason cap 4', async () => {
      // 10 条 .zip + 10 条 .exe + 10 个 ignored-dir → 总不超 10，每类不超 4
      for (let i = 0; i < 10; i++) {
        await mkfile(`z${i}.zip`);
        await mkfile(`e${i}.exe`);
        await mkfile(`node_modules_${i}/x.js`.replace('_', i === 0 ? '' : String(i)));
      }
      // 构造省事：用真的 ignored-dir 名字
      await mkfile('node_modules/a.js');
      await mkfile('dist/b.js');
      await mkfile('build/c.js');
      await mkfile('out/d.js');
      await mkfile('.git/e.js');
      const r = await scanWorkspace(tmpRoot);
      expect(r.filterSamples.length).toBeLessThanOrEqual(10);
      const byReason = new Map<string, number>();
      for (const s of r.filterSamples) {
        byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
      }
      for (const cnt of byReason.values()) {
        expect(cnt).toBeLessThanOrEqual(4);
      }
    });
  });
});
