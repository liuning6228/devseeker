/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PdfExtractor —— PDF 文本提取（C1 文档画像引擎，AssetMeta 通道）。
 *
 * 文本提取统一复用 ../../pdf/extract.ts（pdfjs-dist legacy），本模块只负责：
 * - 读取文件字节与 stat 元信息
 * - 把提取结果 + 标签组装为 AssetMeta
 *
 * 局限（与 extract.ts 一致）：
 * - 不支持扫描件 PDF（需视觉识别通道，见 ../../pdf/vision-ocr.ts）
 * - 加密 / 损坏 PDF 返回 null
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import type { AssetMeta } from './types.js';
import { extractPdfTextLayer, MAX_TEXT_LAYER_PAGES } from '../../pdf/extract.js';

/**
 * 提取 PDF 文件的文本内容并转为 AssetMeta。
 * @param absPath PDF 文件绝对路径
 * @param relPath 工作区相对路径
 * @returns AssetMeta | null（提取失败/无文本返回 null）
 */
export async function extractPdf(absPath: string, relPath: string): Promise<AssetMeta | null> {
  try {
    const stat = await fs.stat(absPath);
    const bytes = new Uint8Array(await fs.readFile(absPath));

    const layer = await extractPdfTextLayer(bytes);
    if (!layer || !layer.text.trim()) return null;

    return {
      relPath,
      type: 'pdf',
      description: layer.text,
      structured: {
        pageCount: layer.pageCount,
        extractedPages: Math.min(layer.pageCount, MAX_TEXT_LAYER_PAGES),
        fileName: path.basename(relPath),
      },
      tags: inferPdfTags(relPath),
      byteSize: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    console.warn(`[PdfExtractor] 提取失败 ${relPath}: ${e}`);
    return null;
  }
}

/** 从路径中推断标签 */
function inferPdfTags(relPath: string): string[] {
  const tags: string[] = ['pdf'];
  const ext = path.extname(relPath).toLowerCase();
  tags.push(ext.replace('.', ''));

  const lower = relPath.toLowerCase();
  if (lower.includes('spec') || lower.includes('specification')) tags.push('specification');
  if (lower.includes('doc') || lower.includes('manual')) tags.push('documentation');
  if (lower.includes('api') || lower.includes('reference')) tags.push('reference');
  if (lower.includes('design') || lower.includes('arch')) tags.push('design');

  return tags;
}
