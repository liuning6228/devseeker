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
 * - 内置 OCR（扫描件 PDF 支持）
 * - 支持 DOCX/XLSX/PPTX/图片等格式（通过 LibreOffice 转换）
 *
 * 架构设计：
 * - 实现与 `extractPdf` 相同的函数签名，便于 AssetIndexer 无感切换
 * - 采用"尝试加载 → 失败降级"模式：LiteParse 不可用时不抛错，返回 null
 * - 通过 `LiteParse` 的 Node.js API（ESM 导入）直接调用，不走 CLI subprocess
 *
 * 依赖：
 * - @llamaindex/liteparse（optionalDependency，用户可选安装）
 * - pdfium 库（由 liteparse 平台包自带）
 */

import type { AssetMeta } from './types.js';

interface LiteParseItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
  confidence?: number;
}

interface LiteParsePage {
  pageNum: number;
  width: number;
  height: number;
  text: string;
  textItems: LiteParseItem[];
}

interface LiteParseResult {
  pages: LiteParsePage[];
  text: string;
}

/** LiteParse 模块的接口类型（动态 import 用） */
interface LiteParseModule {
  LiteParse: new (config?: Record<string, unknown>) => {
    parse(input: string | Buffer): Promise<LiteParseResult>;
  };
}

/** 轻量级加载器：尝试动态导入 liteparse，缓存结果 */
let liteparseModule: LiteParseModule | null = null;
let liteparseLoadAttempted = false;

async function tryLoadLiteParse(): Promise<LiteParseModule | null> {
  if (liteparseLoadAttempted) return liteparseModule;
  liteparseLoadAttempted = true;
  try {
    // ESM 动态 import（liteparse 是 ESM-only 包）
    const mod = await import('@llamaindex/liteparse') as LiteParseModule;
    if (mod && typeof mod.LiteParse === 'function') {
      liteparseModule = mod;
      return mod;
    }
    return null;
  } catch {
    // liteparse 未安装或 native binding 不可用
    return null;
  }
}

/**
 * 使用 LiteParse 提取文档文本。
 * 支持 PDF、DOCX、XLSX、PPTX、图片等格式（需系统安装 LibreOffice 做格式转换）。
 *
 * 若 LiteParse 不可用或提取失败，返回 null（调用方应降级到 pdfjs-dist）。
 */
export async function extractWithLiteParse(absPath: string, relPath: string): Promise<AssetMeta | null> {
  const mod = await tryLoadLiteParse();
  if (!mod) return null;

  try {
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(absPath);
    const ext = relPath.toLowerCase().slice(relPath.lastIndexOf('.'));

    // 仅处理 LiteParse 支持的格式
    const supportedExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp'];
    if (!supportedExts.includes(ext)) return null;

    const parser = new mod.LiteParse({
      ocrEnabled: false,
      ocrLanguage: 'eng',
      maxPages: 100,
      quiet: true,
      outputFormat: 'text',
    });

    const result: LiteParseResult = await parser.parse(absPath);
    if (!result.text || result.text.trim().length < 10) return null;

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

/**
 * 检测 LiteParse 是否可用。
 */
export async function isLiteParseAvailable(): Promise<boolean> {
  const mod = await tryLoadLiteParse();
  return mod !== null;
}
