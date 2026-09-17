/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PDF 渲染与文本层提取测试（图片 PDF 视觉识别通道基础能力）
 *
 * 使用 tests/core/pdf-fixtures.ts 生成 pdfjs 可解析的合法最小 PDF。
 * 这些用例同时是「打包外置（esbuild external）」的回归护栏：
 * 若 pdfjs 被重新内联进 bundle，测试环境（node_modules 直连）仍会通过，
 * 因此另见 scripts/build-and-package.sh 中的 bundle 断言。
 */

import { describe, it, expect } from 'vitest';
import { buildValidPdf } from './pdf-fixtures.js';
import { renderPdfPagesToDataUrls } from '../../src/core/pdf/render.js';
import { extractPdfTextLayer } from '../../src/core/pdf/extract.js';

const JPEG_PREFIX = 'data:image/jpeg;base64,';

describe('renderPdfPagesToDataUrls', () => {
  it('renders each page to a JPEG data URL', { timeout: 30_000 }, async () => {
    const pdf = buildValidPdf(['Page one text', 'Page two text']);
    const r = await renderPdfPagesToDataUrls(pdf, { scale: 1.0, quality: 70 });

    expect(r.totalPages).toBe(2);
    expect(r.pages).toHaveLength(2);
    expect(r.skipped).toEqual([]);

    for (const url of r.pages) {
      expect(url.startsWith(JPEG_PREFIX)).toBe(true);
      const bytes = Buffer.from(url.slice(JPEG_PREFIX.length), 'base64');
      // JPEG magic bytes FFD8
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
      expect(bytes.length).toBeGreaterThan(500);
    }
  });

  it('honors maxPages (renders only the first N pages)', { timeout: 30_000 }, async () => {
    const pdf = buildValidPdf(['A', 'B', 'C']);
    const r = await renderPdfPagesToDataUrls(pdf, { scale: 0.5, quality: 60, maxPages: 2 });

    expect(r.totalPages).toBe(3);
    expect(r.pages).toHaveLength(2);
  });

  it('rejects when signal is already aborted', async () => {
    const pdf = buildValidPdf(['X']);
    const controller = new AbortController();
    controller.abort();
    await expect(
      renderPdfPagesToDataUrls(pdf, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
  });

  it('rejects for unparseable bytes', { timeout: 30_000 }, async () => {
    await expect(
      renderPdfPagesToDataUrls(Buffer.from('this is not a pdf at all')),
    ).rejects.toThrow();
  });
});

describe('extractPdfTextLayer', () => {
  it('extracts text and marks usable for text-layer PDFs', { timeout: 30_000 }, async () => {
    const longText = 'Hello usable text layer, this sentence is definitely longer than fifty characters.';
    const pdf = buildValidPdf([longText]);

    const r = await extractPdfTextLayer(pdf);
    expect(r).not.toBeNull();
    expect(r!.pageCount).toBe(1);
    expect(r!.text).toContain('Hello usable text layer');
    expect(r!.usable).toBe(true);
  });

  it('marks unusable for empty (image-like) PDFs', { timeout: 30_000 }, async () => {
    const pdf = buildValidPdf(['']);

    const r = await extractPdfTextLayer(pdf);
    expect(r).not.toBeNull();
    expect(r!.text.trim()).toBe('');
    expect(r!.usable).toBe(false);
  });

  it('returns null for unparseable bytes', async () => {
    const r = await extractPdfTextLayer(Buffer.from('garbage bytes, not a pdf'));
    expect(r).toBeNull();
  });
});
