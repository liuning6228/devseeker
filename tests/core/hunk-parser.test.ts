/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * hunk-parser 单测（W15.6）
 */

import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff, hunkStats } from '../../src/core/diff/hunk-parser.js';

describe('parseUnifiedDiff', () => {
  it('解析基本 unified diff', () => {
    const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,4 @@
 context before
-deleted line
+added line
+another added
 context after
`;
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.oldPath).toBe('a/src/foo.ts');
    expect(parsed.newPath).toBe('b/src/foo.ts');
    expect(parsed.hunks).toHaveLength(1);

    const hunk = parsed.hunks[0];
    expect(hunk.oldStart).toBe(10);
    expect(hunk.oldCount).toBe(3);
    expect(hunk.newStart).toBe(10);
    expect(hunk.newCount).toBe(4);
    expect(hunk.lines).toHaveLength(5);
    expect(hunk.lines[0]).toMatchObject({ type: 'context', text: 'context before' });
    expect(hunk.lines[1]).toMatchObject({ type: 'del', text: 'deleted line' });
    expect(hunk.lines[2]).toMatchObject({ type: 'add', text: 'added line' });
    expect(hunk.lines[3]).toMatchObject({ type: 'add', text: 'another added' });
    expect(hunk.lines[4]).toMatchObject({ type: 'context', text: 'context after' });
  });

  it('解析多个 hunks', () => {
    const diff = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 line1
-line2
+line2b
@@ -20,1 +20,2 @@
+inserted
 line20
`;
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[0].index).toBe(0);
    expect(parsed.hunks[1].index).toBe(1);
    expect(parsed.hunks[1].newStart).toBe(20);
  });

  it('处理省略 count 的 hunk 头（默认 1）', () => {
    const diff = `--- a/x
+++ b/x
@@ -5 +5,2 @@
 context
+added
`;
    const parsed = parseUnifiedDiff(diff);
    const hunk = parsed.hunks[0];
    expect(hunk.oldCount).toBe(1);
    expect(hunk.newCount).toBe(2);
  });

  it('解析 header 后的函数名', () => {
    const diff = `--- a/x
+++ b/x
@@ -10,3 +10,3 @@ function foo() {
 a
-b
+c
 d
`;
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.hunks[0].header).toBe('function foo() {');
  });

  it('处理空行（视为上下文）', () => {
    const diff = `--- a/x
+++ b/x
@@ -1,2 +1,3 @@
 first

+inserted
`;
    const parsed = parseUnifiedDiff(diff);
    const lines = parsed.hunks[0].lines;
    expect(lines[1]).toMatchObject({ type: 'context', text: '' });
  });

  it('忽略 \\ No newline at end of file', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n line\n\\ No newline at end of file';
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.hunks[0].lines).toHaveLength(1);
    expect(parsed.hunks[0].lines[0].text).toBe('line');
  });
});

describe('hunkStats', () => {
  it('计算 add/del 数量', () => {
    const hunk = parseUnifiedDiff(`@@ -1,3 +1,4 @@
 a
-b
+c
+d
 e
`).hunks[0];
    expect(hunkStats(hunk)).toEqual({ added: 2, removed: 1 });
  });
});
