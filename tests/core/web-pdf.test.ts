/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PDF 内容嗅探测试（web 抓取通道）
 *
 * 历史：本文件曾覆盖零依赖正则提取器（W8.10），该提取器因
 * 「未压缩流重复扫描 + Tj/TJ 前瞻匹配过宽 + 中文乱码」三缺陷已移除，
 * 文本提取统一到 src/core/pdf/extract.ts（覆盖见 pdf-render.test.ts）。
 */

import { describe, it, expect } from 'vitest';
import { isPdfContent } from '../../src/core/web/pdf.js';

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

  it('accepts Uint8Array input', () => {
    expect(isPdfContent(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(true);
  });
});
