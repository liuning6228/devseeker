/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * LiteParse 通道 —— 文档增强提取（@llamaindex/liteparse，optionalDependency）。
 *
 * 合并自 read_file.ts（文本通道）与 index/asset-indexer/liteparse.ts（AssetMeta 通道）
 * 的两个加载器副本：统一为带「加载一次 + 失败缓存」的 tryLoadLiteParse，
 * 避免每次调用重复尝试 import（包缺失时每次都要付出一次失败 import 的代价）。
 *
 * 能力（安装 LiteParse 后可用）：
 * - Office 格式（DOCX/XLSX/PPTX 等，经 LibreOffice 转换）
 * - 空间布局感知（bounding box，供上层选做 AssetMeta）
 *
 * 依赖 @llamaindex/liteparse 必须保持 esbuild external（见 esbuild.mjs 注释：
 * 内联会导致 import.meta.url 丢失、native 绑定加载失败）。
 */

/** 单页结果（LiteParse 输出） */
export interface LiteParsePage {
  pageNum: number;
  width: number;
  height: number;
  text: string;
  textItems: LiteParseItem[];
}

export interface LiteParseItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
  confidence?: number;
}

/** 解析结果 */
export interface LiteParseResult {
  pages: LiteParsePage[];
  text: string;
}

/** LiteParse 模块接口（动态 import 用） */
export interface LiteParseModule {
  LiteParse: new (config?: Record<string, unknown>) => {
    parse(input: string | Buffer): Promise<LiteParseResult>;
  };
}

/** 模块缓存 + 尝试标记（null = 不可用，避免重复失败 import） */
let liteparseModule: LiteParseModule | null = null;
let liteparseLoadAttempted = false;

/**
 * 尝试加载 @llamaindex/liteparse（ESM-only）。
 * 不可用（未安装 / native 绑定失败）时返回 null，且结果被缓存。
 */
export async function tryLoadLiteParse(): Promise<LiteParseModule | null> {
  if (liteparseLoadAttempted) return liteparseModule;
  liteparseLoadAttempted = true;
  try {
    const mod = (await import('@llamaindex/liteparse')) as unknown as LiteParseModule;
    if (mod && typeof mod.LiteParse === 'function') {
      liteparseModule = mod;
      return mod;
    }
    return null;
  } catch {
    // 未安装或 native binding 不可用
    return null;
  }
}

/** 检测 LiteParse 是否可用 */
export async function isLiteParseAvailable(): Promise<boolean> {
  return (await tryLoadLiteParse()) !== null;
}

/**
 * 用 LiteParse 解析文档（自定义配置版）。
 * 不可用或解析失败时返回 null。
 */
export async function parseWithLiteParse(
  absPath: string,
  config?: Record<string, unknown>,
): Promise<LiteParseResult | null> {
  const mod = await tryLoadLiteParse();
  if (!mod) return null;
  try {
    const parser = new mod.LiteParse(config);
    const result = await parser.parse(absPath);
    return result ?? null;
  } catch {
    return null;
  }
}

/**
 * 文本通道（read_file 用）：提取纯文本。
 * 不可用或结果为空时返回 null。
 */
export async function extractWithLiteParse(absPath: string): Promise<string | null> {
  const result = await parseWithLiteParse(absPath, {
    ocrEnabled: false,
    quiet: true,
    outputFormat: 'text',
    maxPages: 100,
  });
  const text = result?.text?.trim();
  return text && text.length > 0 ? text : null;
}
