/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * LiteParseExtractor —— 基于 @llamaindex/liteparse 的增强 PDF/文档提取器（C1 可选通道）
 *
 * 当用户安装了 @llamaindex/liteparse 时，提供比 pdfjs-dist 更强的提取能力：
 * - 空间布局感知（bounding box）
 * - 支持 DOCX/XLSX/PPTX/图片等格式（通过 LibreOffice 转换）
 *
 * 架构设计：
 * - 实现与 `extractPdf` 相同的函数签名，便于 AssetIndexer 无感切换
 * - 采用"尝试加载 → 失败降级"模式：LiteParse 不可用时不抛错，返回 null
 * - 加载器统一复用 ../pdf/liteparse.ts 的共享实现（带加载/失败缓存）
 *
 * 依赖：
 * - @llamaindex/liteparse（optionalDependency）
 * - pdfium 库（由 liteparse 平台包自带）
 */

import type { AssetMeta } from './types.js';
import { parseWithLiteParse, isLiteParseAvailable } from '../../pdf/liteparse.js';

export { isLiteParseAvailable };

/**
 * 使用 LiteParse 提取文档文本并转为 AssetMeta。
 * 支持 PDF、DOCX、XLSX、PPTX、图片等格式（需系统安装 LibreOffice 做格式转换）。
 *
 * 若 LiteParse 不可用或提取失败，返回 null（调用方应降级到 pdfjs-dist）。
 */
export async function extractWithLiteParse(absPath: string, relPath: string): Promise<AssetMeta | null> {
  try {
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(absPath);
    const ext = relPath.toLowerCase().slice(relPath.lastIndexOf('.'));

    // 仅处理 LiteParse 支持的格式
    const supportedExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp'];
    if (!supportedExts.includes(ext)) return null;

    const result = await parseWithLiteParse(absPath, {
      ocrEnabled: false,
      ocrLanguage: 'eng',
      maxPages: 100,
      quiet: true,
      outputFormat: 'text',
    });
    if (!result || !result.text || result.text.trim().length < 10) return null;

    // 将 LiteParse 结果转换为标准 AssetMeta
    const tags: string[] = [ext.replace('.', '')];
    const lower = relPath.toLowerCase();
    if (lower.includes('spec')) tags.push('specification');
    if (lower.includes('doc') || lower.includes('manual')) tags.push('documentation');
    if (lower.includes('api') || lower.includes('reference')) tags.push('reference');
    if (lower.includes('design') || lower.includes('arch')) tags.push('design');
    if (lower.includes('invoice') || lower.includes('receipt')) tags.push('invoice');

    return {
      relPath,
      type: ext === '.pdf' ? 'pdf' : 'image',
      description: result.text.trim(),
      structured: {
        pageCount: result.pages.length,
        liteparse: true,
        fileName: relPath.split('/').pop() ?? relPath,
      },
      tags,
      byteSize: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}
