/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PDF 页渲染 —— 把 PDF 页面渲染为 JPEG DataURL。
 *
 * 用途：图片 PDF（扫描件，无文本层）视觉识别的前置步骤 —— 先渲染为图片，
 * 再交给 VLLM 视觉模型转录（见 vision-ocr.ts）。
 *
 * 依赖（必须保持 esbuild external，见 esbuild.mjs 注释）：
 * - pdfjs-dist/legacy/build/pdf.mjs：Node 环境必须用 legacy 构建
 * - @napi-rs/canvas：Node 端 Canvas 2D 实现；pdfjs 的 DOMMatrix polyfill
 *   也来自它（通过 createRequire 加载），因此二者必须同时可用。
 *
 * 实现要点：
 * - 逐页渲染、逐页编码、逐页释放（不在内存里同时持有全部画布）
 * - 单页长边超 maxEdge 时自动降 scale（防超大页面爆内存）
 * - 单页渲染失败记入 skipped 并继续（不因个别坏页中断整份文档）
 * - loadingTask.destroy() 置于 finally（pdfjs v6 中 PDFDocumentProxy 无 destroy）
 */

/** 渲染参数 */
export interface RenderPdfOptions {
  /** 渲染缩放（默认 1.5，约 110 DPI；A4 → 915x1184） */
  scale?: number;
  /** JPEG 编码质量（默认 80） */
  quality?: number;
  /** 最大渲染页数（undefined = 全部页面） */
  maxPages?: number;
  /** 单页长边像素上限（默认 2200，超出自动降 scale） */
  maxEdge?: number;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 每页渲染完成回调（page 从 1 起，已包含跳过失败的页） */
  onPage?: (page: number, total: number) => void;
}

/** 渲染结果 */
export interface RenderedPdfPages {
  /** 每页 `data:image/jpeg;base64,...`（不含失败页） */
  pages: string[];
  /** 文档总页数 */
  totalPages: number;
  /** 渲染失败的页码（1-based） */
  skipped: number[];
}

// ─────────── pdfjs / canvas 最小类型垫片（动态 import 用） ───────────

interface PdfjsViewport {
  width: number;
  height: number;
}

interface PdfjsPage {
  getViewport(params: { scale: number }): PdfjsViewport;
  render(params: {
    canvasContext: unknown;
    viewport: PdfjsViewport;
  }): { promise: Promise<void> };
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

interface NapiCanvas {
  getContext(type: '2d'): unknown;
  toBuffer(mime: 'image/jpeg', quality?: number): Buffer;
}

interface NapiCanvasModule {
  createCanvas(width: number, height: number): NapiCanvas;
}

/**
 * 把 PDF 渲染为逐页 JPEG DataURL。
 *
 * @param data PDF 文件字节（内部复制一份，调用方可安全复用）
 * @returns pages / totalPages / skipped；全部页失败时 pages 为空数组
 * @throws 文档无法打开 / 取消时抛出（AbortError 语义）
 */
export async function renderPdfPagesToDataUrls(
  data: Uint8Array,
  opts: RenderPdfOptions = {},
): Promise<RenderedPdfPages> {
  const scale = opts.scale ?? 1.5;
  const quality = opts.quality ?? 80;
  const maxEdge = opts.maxEdge ?? 2200;
  const signal = opts.signal;

  // 复制字节：pdfjs 可能转移（detach）底层 buffer，调用方的数据需保持可用
  const bytes = new Uint8Array(data);

  // legacy 构建 + 运行时真实文件加载（external）：worker 自动回退同线程 fake worker
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule;
  const { createCanvas } = (await import('@napi-rs/canvas')) as unknown as NapiCanvasModule;

  assertNotAborted(signal);

  const loadingTask = pdfjs.getDocument({ data: bytes });
  const doc = await loadingTask.promise;

  try {
    const total = doc.numPages;
    const limit = Math.max(1, Math.min(total, opts.maxPages && opts.maxPages > 0 ? opts.maxPages : total));
    const pages: string[] = [];
    const skipped: number[] = [];

    for (let i = 1; i <= limit; i++) {
      assertNotAborted(signal);
      try {
        const page = await doc.getPage(i);
        const baseViewport = page.getViewport({ scale });
        // 单页像素上限保护：长边超限时等比缩小
        const longEdge = Math.max(baseViewport.width, baseViewport.height);
        const pageScale = longEdge > maxEdge
          ? scale * (maxEdge / longEdge)
          : scale;
        const viewport = page.getViewport({ scale: pageScale });

        const canvas = createCanvas(
          Math.max(1, Math.ceil(viewport.width)),
          Math.max(1, Math.ceil(viewport.height)),
        );
        const canvasContext = canvas.getContext('2d');
        await page.render({ canvasContext, viewport }).promise;

        const jpeg = canvas.toBuffer('image/jpeg', quality);
        pages.push(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
      } catch {
        // 取消优先：abort 时不再吞错；否则记录失败页并继续
        assertNotAborted(signal);
        skipped.push(i);
      }
      opts.onPage?.(i, limit);
    }

    return { pages, totalPages: total, skipped };
  } finally {
    // pdfjs v6：destroy 在 loadingTask 上；吞掉销毁异常避免掩盖主流程错误
    await loadingTask.destroy().catch(() => undefined);
  }
}

/** 统一取消检查：抛出 name='AbortError' 的错误 */
function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('PDF rendering aborted');
    err.name = 'AbortError';
    throw err;
  }
}
