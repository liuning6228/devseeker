/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * hunk-reverter 单测（W15.6）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseUnifiedDiff } from '../../src/core/diff/hunk-parser.js';
import { revertHunk } from '../../src/core/diff/hunk-reverter.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-hunk-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFile(rel: string, content: string): Promise<string> {
  const abs = path.join(tmpDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
  return abs;
}

async function readFile(rel: string): Promise<string> {
  return fs.readFile(path.join(tmpDir, rel), 'utf-8');
}

describe('revertHunk', () => {
  it('revert 简单的 add/del hunk', async () => {
    const diff = parseUnifiedDiff(`--- a/foo.txt
+++ b/foo.txt
@@ -2,3 +2,3 @@
 line1
-deleted
+inserted
 line3
`);
    const abs = await writeFile('foo.txt', 'line1\ninserted\nline3\n');

    const result = await revertHunk(abs, diff.hunks[0]);
    expect(result.ok).toBe(true);
    expect(await readFile('foo.txt')).toBe('line1\ndeleted\nline3\n');
  });

  it('revert 纯 add hunk（删除新增行）', async () => {
    const diff = parseUnifiedDiff(`--- a/foo.txt
+++ b/foo.txt
@@ -2,2 +2,4 @@
 line2
+newA
+newB
 line3
`);
    const abs = await writeFile('foo.txt', 'line1\nline2\nnewA\nnewB\nline3\n');

    const result = await revertHunk(abs, diff.hunks[0]);
    expect(result.ok).toBe(true);
    expect(await readFile('foo.txt')).toBe('line1\nline2\nline3\n');
  });

  it('revert 纯 del hunk（恢复删除行）', async () => {
    const diff = parseUnifiedDiff(`--- a/foo.txt
+++ b/foo.txt
@@ -2,4 +2,2 @@
 line2
-removedA
-removedB
 line5
`);
    const abs = await writeFile('foo.txt', 'line1\nline2\nline5\n');

    const result = await revertHunk(abs, diff.hunks[0]);
    expect(result.ok).toBe(true);
    expect(await readFile('foo.txt')).toBe('line1\nline2\nremovedA\nremovedB\nline5\n');
  });

  it('保持 CRLF 换行风格', async () => {
    const diff = parseUnifiedDiff(`--- a/foo.txt
+++ b/foo.txt
@@ -1,2 +1,2 @@
 old
-replaced
+new
`);
    const abs = await writeFile('foo.txt', 'old\r\nnew\r\n');

    const result = await revertHunk(abs, diff.hunks[0]);
    expect(result.ok).toBe(true);
    const content = await readFile('foo.txt');
    expect(content).toBe('old\r\nreplaced\r\n');
  });

  it('滑动窗口定位：行号偏移仍能找到', async () => {
    const diff = parseUnifiedDiff(`--- a/foo.txt
+++ b/foo.txt
@@ -5,2 +5,3 @@
 a
+inserted
 b
`);
    // 实际文件在 diff 生成后被插入了一行，导致 hunk 从第 6 行开始
    const abs = await writeFile('foo.txt', '1\n2\n3\n4\nextra\na\ninserted\nb\n');

    const result = await revertHunk(abs, diff.hunks[0]);
    expect(result.ok).toBe(true);
    expect(await readFile('foo.txt')).toBe('1\n2\n3\n4\nextra\na\nb\n');
  });

  it('文件被大幅修改后定位失败', async () => {
    const diff = parseUnifiedDiff(`--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,3 @@
 a
-b
+c
 d
`);
    const abs = await writeFile('foo.txt', 'completely\ndifferent\ncontent\nhere\n');

    const result = await revertHunk(abs, diff.hunks[0]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('无法在文件中定位');
  });
});
