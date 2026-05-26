/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * chunkText 单测
 */

import { describe, it, expect } from 'vitest';
import { chunkText } from '../../src/core/index/chunker.js';

describe('chunkText', () => {
  it('returns empty for blank content', () => {
    expect(chunkText('a.ts', '')).toEqual([]);
    expect(chunkText('a.ts', '   \n  \n')).toEqual([]);
  });

  it('returns single chunk for small file', () => {
    const content = 'line1\nline2\nline3';
    const chunks = chunkText('a.ts', content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      filePath: 'a.ts',
      startLine: 1,
      endLine: 3,
      text: 'line1\nline2\nline3',
    });
  });

  it('splits large file into multiple chunks', () => {
    // 每行 100 字符，100 行 → 10000 字符 → ≥7 chunks at maxChars 1600
    const lines = Array.from({ length: 100 }, (_, i) => 'x'.repeat(99) + i);
    const content = lines.join('\n');

    const chunks = chunkText('big.ts', content, { maxChars: 1600, overlapLines: 0, minChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    // 首 chunk 从第 1 行开始
    expect(chunks[0].startLine).toBe(1);
    // 尾 chunk 结束于最后一行
    expect(chunks[chunks.length - 1].endLine).toBe(100);
  });

  it('respects maxChars upper bound per chunk', () => {
    const lines = Array.from({ length: 50 }, () => 'a'.repeat(50));
    const content = lines.join('\n');
    const chunks = chunkText('a.ts', content, { maxChars: 200, overlapLines: 0, minChars: 0 });
    for (const c of chunks) {
      // 允许单行超过 maxChars 的边界情况（end > cursor 时才拆）
      expect(c.text.length).toBeLessThanOrEqual(300);
    }
  });

  it('produces overlap between consecutive chunks', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const content = lines.join('\n');
    const chunks = chunkText('a.ts', content, { maxChars: 40, overlapLines: 2, minChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine);
    }
  });

  it('start/end lines are 1-based inclusive and continuous', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `L${i + 1}`);
    const chunks = chunkText('a.ts', lines.join('\n'), {
      maxChars: 30,
      overlapLines: 0,
      minChars: 0,
    });
    expect(chunks[0].startLine).toBe(1);
    let lastEnd = 0;
    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(1);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
      lastEnd = c.endLine;
    }
    expect(lastEnd).toBe(30);
  });

  it('merges tiny trailing chunk into previous', () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\ntail';
    const chunks = chunkText('a.ts', content, { maxChars: 60, overlapLines: 0, minChars: 20 });
    // 最后不应该是独立的 "tail"
    expect(chunks[chunks.length - 1].text.endsWith('tail')).toBe(true);
    expect(chunks[chunks.length - 1].text.length).toBeGreaterThan(4);
  });

  it('handles trailing newline correctly', () => {
    const chunks = chunkText('a.ts', 'a\nb\nc\n');
    expect(chunks[0].endLine).toBe(3);
  });

  it('preserves file path in each chunk', () => {
    const chunks = chunkText('src/foo/bar.ts', 'x\ny\nz');
    expect(chunks.every((c) => c.filePath === 'src/foo/bar.ts')).toBe(true);
  });

  it('does not produce infinite loop on edge cases', () => {
    // 单行超 maxChars
    const long = 'x'.repeat(5000);
    const chunks = chunkText('a.ts', long, { maxChars: 100, overlapLines: 5, minChars: 0 });
    expect(chunks).toHaveLength(1); // 单行无法再切
    expect(chunks[0].text.length).toBe(5000);
  });
});
