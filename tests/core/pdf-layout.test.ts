/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PDF 版面分析单测（translate_pdf 的版面层）
 *
 * 覆盖：行聚类（空格补全）、段落聚类（间距/缩进/字号断裂）、
 * 不可译过滤、中文占比判定、居中启发、真实 PDF 集成提取。
 */

import { describe, it, expect } from 'vitest';
import {
  toRawItems,
  groupIntoLines,
  groupIntoParagraphs,
  isTranslatable,
  looksPrimarilyChinese,
  extractLayoutSegments,
} from '../../src/core/pdf/layout.js';
import { buildValidPdf } from './pdf-fixtures.js';

/** 构造与 RawItem 形状一致的测试项 */
function item(str: string, x: number, y: number, options: { width?: number; fontSize?: number } = {}) {
  const fontSize = options.fontSize ?? 12;
  return {
    str,
    x,
    y,
    width: options.width ?? str.length * fontSize * 0.5,
    height: fontSize,
    fontSize,
  };
}

describe('toRawItems', () => {
  it('maps pdfjs text items and skips blank strings', () => {
    const items = toRawItems([
      { str: 'Hello', transform: [12, 0, 0, 12, 50, 700], width: 30, height: 12 },
      { str: '  ', transform: [12, 0, 0, 12, 80, 700], width: 4, height: 12 },
      { str: 'World', transform: [12, 0, 0, 12, 90, 700], width: 30, height: 12 },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ str: 'Hello', x: 50, y: 700, fontSize: 12 });
  });
});

describe('groupIntoLines', () => {
  it('merges items on the same baseline with a space on visible gap', () => {
    const lines = groupIntoLines([
      item('Hello', 50, 700, { width: 30 }),
      item('World', 90, 700, { width: 30 }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('Hello World');
    expect(lines[0]!.x).toBe(50);
    expect(lines[0]!.width).toBe(70); // 到 120
  });

  it('does not insert a space when glyphs are contiguous', () => {
    const lines = groupIntoLines([
      item('AB', 0, 100, { width: 12 }),
      item('CD', 12, 100, { width: 12 }),
    ]);
    expect(lines[0]!.text).toBe('ABCD');
  });

  it('splits different baselines into separate lines, ordered top-down', () => {
    const lines = groupIntoLines([
      item('first', 50, 700),
      item('second', 50, 680),
      item('third', 50, 660),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['first', 'second', 'third']);
  });
});

describe('groupIntoParagraphs', () => {
  const pageWidth = 600;

  it('groups consecutive close lines and splits on large vertical gap', () => {
    const lines = groupIntoLines([
      item('Line one of paragraph A', 72, 700),
      item('Line two of paragraph A', 72, 686), // gap 14 ≤ 1.7×12
      item('Paragraph B starts here', 72, 640), // gap 46 > 20.4
    ]);
    const segs = groupIntoParagraphs(lines, 1, pageWidth);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.text).toBe('Line one of paragraph A Line two of paragraph A');
    expect(segs[1]!.text).toBe('Paragraph B starts here');
    expect(segs[0]!.lines).toHaveLength(2);
  });

  it('splits on font size change (heading vs body)', () => {
    const lines = groupIntoLines([
      item('Big Heading', 72, 700, { fontSize: 20 }),
      item('Body text begins below', 72, 668, { fontSize: 11 }), // gap 32 > 1.7×20=34? 32 ≤ 34 → 但字号差 9 > 20×0.25=5 → 断段
    ]);
    const segs = groupIntoParagraphs(lines, 1, pageWidth);
    expect(segs).toHaveLength(2);
  });

  it('detects centered single-line segments', () => {
    // 页面中心 300；文本宽 100，居中则 x=250
    const lines = groupIntoLines([item('Centered Title', 250, 700, { width: 100 })]);
    const segs = groupIntoParagraphs(lines, 1, pageWidth);
    expect(segs[0]!.align).toBe('center');
  });

  it('keeps left-aligned segments as left', () => {
    const lines = groupIntoLines([item('Left aligned body text', 72, 700, { width: 260 })]);
    const segs = groupIntoParagraphs(lines, 1, pageWidth);
    expect(segs[0]!.align).toBe('left');
  });

  it('filters untranslatable segments (numbers / mostly Chinese)', () => {
    const lines = groupIntoLines([
      item('12345 67890', 72, 700),
      item('已基本是中文的一行内容', 72, 686),
      item('Real English sentence', 72, 640),
    ]);
    const segs = groupIntoParagraphs(lines, 1, pageWidth);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe('Real English sentence');
  });
});

describe('isTranslatable', () => {
  it('rejects short/numeric/non-latin text', () => {
    expect(isTranslatable('1234')).toBe(false);
    expect(isTranslatable('— 42 —')).toBe(false);
    expect(isTranslatable('中文字符')).toBe(false);
    expect(isTranslatable('')).toBe(false);
  });

  it('rejects text with >40% CJK', () => {
    expect(isTranslatable('Hello 世界测试中文内容')).toBe(false); // 5 CJK / 10 = 50%
    expect(isTranslatable('Hello 世界')).toBe(true); // 2/7 ≈ 29%
  });

  it('accepts normal English text', () => {
    expect(isTranslatable('This is a normal sentence.')).toBe(true);
  });
});

describe('looksPrimarilyChinese', () => {
  it('returns true for Chinese-dominant segments', () => {
    const segs = [
      { text: '这是一个中文文档的内容说明' },
      { text: '还有一些中文文字' },
    ] as never[];
    expect(looksPrimarilyChinese(segs)).toBe(true);
  });

  it('returns false for English-dominant segments', () => {
    const segs = [
      { text: 'This is an English document about APIs' },
      { text: 'More English content here' },
    ] as never[];
    expect(looksPrimarilyChinese(segs)).toBe(false);
  });
});

describe('extractLayoutSegments (integration)', () => {
  it('extracts segments from a text-layer fixture PDF', { timeout: 30_000 }, async () => {
    const pdf = buildValidPdf(['A readable English paragraph used for layout extraction tests.']);
    const layout = await extractLayoutSegments(pdf);

    expect(layout.totalPages).toBe(1);
    expect(layout.pages).toHaveLength(1);
    expect(layout.pages[0]!.segments.length).toBeGreaterThanOrEqual(1);
    const seg = layout.pages[0]!.segments[0]!;
    expect(seg.text).toContain('readable English paragraph');
    expect(seg.fontSize).toBeGreaterThan(0);
    expect(seg.bbox.width).toBeGreaterThan(0);
    expect(seg.lines.length).toBeGreaterThanOrEqual(1);
  });

  it('respects page subset', { timeout: 30_000 }, async () => {
    const pdf = buildValidPdf(['Page one English text here.', 'Page two English text here.']);
    const layout = await extractLayoutSegments(pdf, { pages: [2] });
    expect(layout.pages).toHaveLength(1);
    expect(layout.pages[0]!.pageNumber).toBe(2);
    expect(layout.pages[0]!.segments[0]!.page).toBe(2);
  });
});
