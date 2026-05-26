/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PDF 文本提取测试（W8.10 / DESIGN §M12.5）
 *
 * 构造最小 PDF 数据（非压缩内容流）验证提取算法；FlateDecode 分支通过 zlib 手工构造。
 */

import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { isPdfContent, extractPdfText } from '../../src/core/web/pdf.js';

/** 构造一个最小的"合法样貌"的未压缩 PDF。 */
function makePlainPdf(bodyText: string): Buffer {
  const contentStream = `BT /F1 12 Tf 72 720 Td (${bodyText}) Tj ET`;
  const stream = `stream\n${contentStream}\nendstream`;
  const head = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n<< /Length ${contentStream.length} >>\n${stream}\nendobj\n`;
  return Buffer.from(head, 'latin1');
}

/** 构造一个 FlateDecode 压缩内容流的 PDF。 */
function makeFlatePdf(bodyText: string): Buffer {
  const contentStream = `BT /F1 12 Tf 72 720 Td (${bodyText}) Tj ET`;
  const compressed = deflateSync(Buffer.from(contentStream, 'latin1'));
  // 字节 → latin1 字符串以拼接
  let compressedStr = '';
  for (const b of compressed) compressedStr += String.fromCharCode(b);
  const head = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressedStr}\nendstream\nendobj\n`;
  return Buffer.from(head, 'latin1');
}

describe('isPdfContent', () => {
  it('detects %PDF- magic bytes', () => {
    const buf = Buffer.from('%PDF-1.4\nfoo', 'latin1');
    expect(isPdfContent(buf)).toBe(true);
  });

  it('rejects non-PDF content', () => {
    expect(isPdfContent(Buffer.from('<html>', 'latin1'))).toBe(false);
    expect(isPdfContent(Buffer.from('', 'latin1'))).toBe(false);
    expect(isPdfContent(Buffer.from('%P', 'latin1'))).toBe(false);
  });
});

describe('extractPdfText', () => {
  it('returns ok=false when not a PDF', () => {
    const r = extractPdfText(Buffer.from('hello world this is not pdf', 'latin1'));
    expect(r.ok).toBe(false);
    expect(r.text).toBe('');
  });

  it('extracts plain (uncompressed) text from Tj operator', () => {
    const body = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.';
    const pdf = makePlainPdf(body);
    const r = extractPdfText(pdf);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('quick brown fox');
    expect(r.text).toContain('lazy dog');
  });

  it('extracts text from FlateDecode-compressed content stream', () => {
    const body = 'Welcome to the compressed PDF extraction test with enough words to pass the 50-char threshold.';
    const pdf = makeFlatePdf(body);
    const r = extractPdfText(pdf);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('compressed PDF extraction test');
  });

  it('returns ok=false when extracted text is too short', () => {
    const body = 'hi';
    const pdf = makePlainPdf(body);
    const r = extractPdfText(pdf);
    expect(r.ok).toBe(false);
    expect(r.byteSize).toBe(pdf.byteLength);
  });

  it('handles escaped parentheses in text', () => {
    // (foo \(bar\) baz) Tj
    const content = `BT (foo \\(bar\\) baz is here with plenty of characters to meet the length requirement.) Tj ET`;
    const head = `%PDF-1.4\n1 0 obj << >> endobj\n2 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
    const pdf = Buffer.from(head, 'latin1');
    const r = extractPdfText(pdf);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('foo (bar) baz');
  });
});
