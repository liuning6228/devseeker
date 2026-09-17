/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PDF 内容嗅探（web 抓取通道）。
 *
 * 历史说明：本模块曾包含一个零依赖的正则提取器（避免 .vsix 膨胀），
 * 但其存在三个缺陷：未压缩 PDF 流被重复扫描、`Tj/TJ` 前瞻匹配过宽导致误提取、
 * 无 CID/ToUnicode 映射中文乱码。pdfjs-dist 已随包分发（external）后，
 * 文本提取统一到 src/core/pdf/extract.ts，本模块仅保留 magic bytes 嗅探。
 */

const PDF_MAGIC = '%PDF-';

/** 检测字节流是否为 PDF（magic bytes: %PDF-） */
export function isPdfContent(bytes: Uint8Array | Buffer): boolean {
  if (bytes.length < 5) return false;
  for (let i = 0; i < 5; i++) {
    if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}
