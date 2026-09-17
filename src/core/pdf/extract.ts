/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PDF 文本层提取（pdfjs-dist）。
 *
 * 迁移自 read_file.ts 内部实现（避免两份重复的 pdfjs 提取逻辑）：
 * - 按垂直位置排序还原阅读顺序（Y 坐标，10px 容差视为同一行）
 * - 最多处理 MAX_TEXT_LAYER_PAGES 页（防超长文档拖慢）
 * - loadingTask.destroy() 置于 finally（pdfjs v6 中 PDFDocumentProxy 无 destroy）
 *
 * 依赖 pdfjs-dist/legacy/build/pdf.mjs 必须保持 esbuild external
 * （见 esbuild.mjs 注释：内联会导致 import.meta.url 丢失、模块初始化即抛错）。
 *
 * 语义：
 * - 返回 null = 文档无法解析（损坏 / 加密 / 非法格式）
 * - usable = false = 能解析但没有可用文本层（图片 PDF / 扫描件）→ 调用方可走
 *   视觉识别兜底（见 vision-ocr.ts）
 */

/** 判定文本层「可用」的最小字符数；低于此值视为无文本层（图片 PDF） */
export const MIN_USABLE_TEXT_CHARS = 50;

/** 文本层提取最多处理的页数（超出部分不参与文本提取） */
export const MAX_TEXT_LAYER_PAGES = 100;

export interface PdfTextLayerResult {
  /** 提取的纯文本（可能为空字符串） */
  text: string;
  /** 文档总页数 */
  pageCount: number;
  /** 文本层是否达到可用阈值（text.length >= MIN_USABLE_TEXT_CHARS） */
  usable: boolean;
}

// ─────────── pdfjs 最小类型垫片（动态 import 用） ───────────

interface PdfjsTextItem {
  str?: string;
  transform?: number[];
}

interface PdfjsPage {
  getTextContent(): Promise<{ items: PdfjsTextItem[] }>;
}

interface PdfjsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPage>;
}

interface PdfjsLoadingTask {
  promise: Promise<PdfjsDocument>;
  destroy(): Promise<void>;
}

interface PdfjsModule {
  getDocument(src: { data: Uint8Array }): PdfjsLoadingTask;
}

/**
 * 提取 PDF 文本层。
 *
 * @param data PDF 文件字节（内部复制一份，调用方可安全复用）
 * @returns 解析失败返回 null；成功返回 text / pageCount / usable
 */
export async function extractPdfTextLayer(data: Uint8Array): Promise<PdfTextLayerResult | null> {
  try {
    // Node.js 环境必须用 legacy 构建；worker 自动回退同线程 fake worker
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule;

    // 复制字节：pdfjs 可能转移（detach）底层 buffer，调用方的数据需保持可用
    const bytes = new Uint8Array(data);
    const loadingTask = pdfjs.getDocument({ data: bytes });
    const doc = await loadingTask.promise;

    try {
      const totalPages = doc.numPages;
      const maxPages = Math.min(totalPages, MAX_TEXT_LAYER_PAGES);
      const pages: string[] = [];

      for (let i = 1; i <= maxPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const items = content.items;

        // 按垂直位置排序，还原阅读顺序（Y 越大越靠上）
        const sorted = items.slice().sort((a, b) => {
          const aY = Math.round(a.transform?.[5] ?? 0);
          const bY = Math.round(b.transform?.[5] ?? 0);
          if (Math.abs(aY - bY) < 10) return 0;
          return bY - aY;
        });

        const text = sorted
          .map((item) => item.str ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) pages.push(text);
      }

      const fullText = pages.join('\n\n');
      return {
        text: fullText,
        pageCount: totalPages,
        usable: fullText.trim().length >= MIN_USABLE_TEXT_CHARS,
      };
    } finally {
      // pdfjs v6：destroy 在 loadingTask 上；吞掉销毁异常避免掩盖主流程错误
      await loadingTask.destroy().catch(() => undefined);
    }
  } catch {
    return null;
  }
}
