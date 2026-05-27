/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * diff-utils 单测（W7b4b DESIGN §M11.1）
 *
 * 覆盖：
 * - created：before=undefined → --- /dev/null + 全 +
 * - deleted：after=undefined → +++ /dev/null + 全 -
 * - identical content → unified=''
 * - middle change：context=3 包围 hunk
 * - CRLF split：Windows 换行被正确处理
 * - 空字符串 before / after：视作 0 行
 * - trailing newline 不影响行数
 * - 大文件 fallback：超过 LCS cell 限额 → 全 -/全 + 输出
 */

import { describe, it, expect } from 'vitest';
import { makeUnifiedDiff, truncateUnifiedDiff, MAX_HUNKS_FOR_WEBVIEW } from '../../src/core/tools/diff-utils.js';

describe('makeUnifiedDiff · created', () => {
  it('before=undefined emits --- /dev/null and all + lines', () => {
    const r = makeUnifiedDiff(undefined, 'a\nb\n', { relPath: 'foo.txt' });
    expect(r.added).toBe(2);
    expect(r.removed).toBe(0);
    expect(r.unified).toContain('--- /dev/null');
    expect(r.unified).toContain('+++ b/foo.txt');
    expect(r.unified).toContain('+a');
    expect(r.unified).toContain('+b');
  });

  it('explicit created=true forces created form', () => {
    const r = makeUnifiedDiff('whatever', 'x\n', {
      relPath: 'x.ts',
      created: true,
    });
    expect(r.unified).toContain('--- /dev/null');
    expect(r.unified).toContain('+x');
  });

  it('created empty file → 0 added / 0 removed', () => {
    const r = makeUnifiedDiff(undefined, '', { relPath: 'empty.txt' });
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });
});

describe('makeUnifiedDiff · deleted', () => {
  it('after=undefined emits +++ /dev/null and all - lines', () => {
    const r = makeUnifiedDiff('a\nb\nc\n', undefined, { relPath: 'gone.txt' });
    expect(r.added).toBe(0);
    expect(r.removed).toBe(3);
    expect(r.unified).toContain('--- a/gone.txt');
    expect(r.unified).toContain('+++ /dev/null');
    expect(r.unified).toContain('-a');
    expect(r.unified).toContain('-b');
    expect(r.unified).toContain('-c');
  });

  it('explicit deleted=true forces deleted form', () => {
    const r = makeUnifiedDiff('x\n', 'ignored', {
      relPath: 'g.md',
      deleted: true,
    });
    expect(r.unified).toContain('+++ /dev/null');
    expect(r.unified).toContain('-x');
  });
});

describe('makeUnifiedDiff · unchanged', () => {
  it('identical content → unified="" and counts are 0', () => {
    const r = makeUnifiedDiff('a\nb\nc\n', 'a\nb\nc\n', { relPath: 'same.txt' });
    expect(r.unified).toBe('');
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it('trailing newline vs no trailing newline same number of lines', () => {
    const r = makeUnifiedDiff('a\nb', 'a\nb', { relPath: 'same.txt' });
    expect(r.unified).toBe('');
  });
});

describe('makeUnifiedDiff · middle change', () => {
  it('mid-file replacement emits hunk with +/-/context', () => {
    const before =
      'line1\nline2\nline3\nTARGET\nline5\nline6\nline7\n';
    const after =
      'line1\nline2\nline3\nCHANGED\nline5\nline6\nline7\n';
    const r = makeUnifiedDiff(before, after, { relPath: 'a.txt' });
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.unified).toContain('-TARGET');
    expect(r.unified).toContain('+CHANGED');
    // context lines (prefix space)
    expect(r.unified).toContain(' line1');
    expect(r.unified).toContain(' line5');
    // hunk header present
    expect(r.unified).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/m);
    // headers
    expect(r.unified.startsWith('--- a/a.txt\n+++ b/a.txt')).toBe(true);
  });

  it('pure addition at end produces + only', () => {
    const before = 'a\nb\n';
    const after = 'a\nb\nc\nd\n';
    const r = makeUnifiedDiff(before, after, { relPath: 'p.txt' });
    expect(r.added).toBe(2);
    expect(r.removed).toBe(0);
    expect(r.unified).toContain('+c');
    expect(r.unified).toContain('+d');
  });

  it('pure deletion at end produces - only', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nb\n';
    const r = makeUnifiedDiff(before, after, { relPath: 'p.txt' });
    expect(r.added).toBe(0);
    expect(r.removed).toBe(2);
    expect(r.unified).toContain('-c');
    expect(r.unified).toContain('-d');
  });
});

describe('makeUnifiedDiff · CRLF handling', () => {
  it('CRLF and LF treated as same line content', () => {
    const before = 'a\r\nb\r\nc\r\n';
    const after = 'a\nb\nc\n';
    const r = makeUnifiedDiff(before, after, { relPath: 'x.txt' });
    expect(r.unified).toBe('');
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it('mixed CRLF change emits correct diff', () => {
    const before = 'a\r\nOLD\r\nb\r\n';
    const after = 'a\r\nNEW\r\nb\r\n';
    const r = makeUnifiedDiff(before, after, { relPath: 'x.txt' });
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.unified).toContain('-OLD');
    expect(r.unified).toContain('+NEW');
  });
});

describe('makeUnifiedDiff · large file fallback', () => {
  it('> LCS_CELL_LIMIT cells → fallback full -/+ dump', () => {
    // 2001 * 2001 > 4_000_000 limit
    const lines = Array.from({ length: 2001 }, (_, i) => `line${i}`).join('\n');
    const before = lines;
    const after = lines + '\nEXTRA';
    const r = makeUnifiedDiff(before, after, { relPath: 'big.txt' });
    // fallback: all before as -, all after as +
    expect(r.removed).toBe(2001);
    expect(r.added).toBe(2002);
    expect(r.unified).toContain('--- a/big.txt');
    expect(r.unified).toContain('+++ b/big.txt');
    expect(r.unified).toContain('-line0');
    expect(r.unified).toContain('+EXTRA');
  });
});

describe('truncateUnifiedDiff · large diff protection', () => {
  it('small diff is not truncated', () => {
    const r = makeUnifiedDiff('a\nb\nc\n', 'a\nX\nc\n', { relPath: 'small.txt' });
    const t = truncateUnifiedDiff(r.unified);
    expect(t.truncated).toBe(false);
    expect(t.totalHunks).toBe(t.shownHunks);
    expect(t.unified).toBe(r.unified);
  });

  it('large diff with many hunks is truncated', () => {
    // 生成一个有 50 个 hunk 的 diff（每个 hunk 之间间隔 8 行 context，确保独立 hunk）
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    for (let i = 0; i < 50; i++) {
      // 8 行不变 context（超过 2*3=6 的 hunk 分割阈值，产生独立 hunk）
      for (let j = 0; j < 8; j++) {
        beforeLines.push(`ctx${i}_${j}`);
        afterLines.push(`ctx${i}_${j}`);
      }
      // 1 行修改
      beforeLines.push(`old${i}`);
      afterLines.push(`new${i}`);
    }
    const before = beforeLines.join('\n');
    const after = afterLines.join('\n');
    const r = makeUnifiedDiff(before, after, { relPath: 'many-hunks.txt' });

    // 确认 diff 有很多 hunk
    const hunkCount = (r.unified.match(/^@@/gm) || []).length;
    expect(hunkCount).toBeGreaterThan(MAX_HUNKS_FOR_WEBVIEW);

    const t = truncateUnifiedDiff(r.unified);
    expect(t.truncated).toBe(true);
    expect(t.totalHunks).toBe(hunkCount);
    expect(t.shownHunks).toBe(MAX_HUNKS_FOR_WEBVIEW);
    expect(t.unified).toContain('diff truncated');
  });

  it('truncated unified still has header', () => {
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    for (let i = 0; i < 50; i++) {
      for (let j = 0; j < 8; j++) {
        beforeLines.push(`ctx${i}_${j}`);
        afterLines.push(`ctx${i}_${j}`);
      }
      beforeLines.push(`old${i}`);
      afterLines.push(`new${i}`);
    }
    const r = makeUnifiedDiff(beforeLines.join('\n'), afterLines.join('\n'), { relPath: 'test.ts' });
    const t = truncateUnifiedDiff(r.unified);
    expect(t.unified).toContain('--- a/test.ts');
    expect(t.unified).toContain('+++ b/test.ts');
  });
});
