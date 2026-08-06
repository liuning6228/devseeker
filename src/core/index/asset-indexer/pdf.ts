/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PdfExtractor —— pdfjs-dist 全量渲染引擎（C1 文档画像引擎）
 *
 * 替换 `src/core/web/pdf.ts` 的极简实现。
 * 基于 pdfjs-dist 的标准文本内容提取，支持：
 * - 中文 PDF（CID/Unicode 映射由 pdfjs 处理）
 * - 多页 PDF（限制 maxPages=100 防爆）
 * - 按阅读顺序还原文本
 *
 * 局限：
 * - 不支持扫描件 PDF（需 OCR 层，此版本不做）
 * - 不支持表格结构化还原（文本流式输出，格式信息不保留）
 * - 不支持加密 PDF
 *
 * 性能要求：
 * - pdfjs-dist 使用 worker 加载 WASM（延迟初始化），首次调用约 200-500ms
 * - 100 页标准 PDF 提取耗时约 1-3s（视 WASM 后端性能）
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import type { AssetMeta } from './types.js';

/**
 * 提取 PDF 文件的文本内容。
 * @param absPath PDF 文件绝对路径
 * @param relPath 工作区相对路径
 * @returns AssetMeta | null（提取失败返回 null）
 */
export async function extractPdf(absPath: string, relPath: string): Promise<AssetMeta | null> {
  try {
    // 动态导入 pdfjs-dist（延迟加载，避免冷启动开销）
    // Node.js 环境必须用 legacy 构建，否则 DOMMatrix is not defined
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // 设置 worker 路径（如果未配置，pdfjs 会自动 fallback 到同线程）
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = '';
    }

    const data = new Uint8Array(await fs.readFile(absPath));
    const doc = await pdfjs.getDocument({ data }).promise;
    const stat = await fs.stat(absPath);

    const maxPages = Math.min(doc.numPages, 100);
    const pages: string[] = [];

    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // 按垂直位置排序，还原阅读顺序
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = content.items as any[];
      const sorted = items.slice().sort((a: any, b: any) => {
        const aY = Math.round(a.transform?.[5] ?? 0);
        const bY = Math.round(b.transform?.[5] ?? 0);
        if (Math.abs(aY - bY) < 10) return 0;
        return bY - aY;
      });
      const text = sorted
        .map((item: any) => item.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) pages.push(text);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (doc as any).destroy();

    const fullText = pages.join('\n\n');
    if (!fullText.trim()) return null;

    return {
      relPath,
      type: 'pdf',
      description: fullText,
      structured: {
        pageCount: doc.numPages,
        extractedPages: maxPages,
        fileName: path.basename(relPath),
      },
      tags: inferPdfTags(relPath, fullText),
      byteSize: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    console.warn(`[PdfExtractor] 提取失败 ${relPath}: ${e}`);
    return null;
  }
}

/** 从路径和文本中推断标签 */
function inferPdfTags(relPath: string, text: string): string[] {
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
