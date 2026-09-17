/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PDF 版面分析 —— 把 PDF 文本内容按「行 → 段落」聚合成可翻译段（translate_pdf 前置）。
 *
 * 坐标系：pdfjs 文本项 transform/width/height 为 PDF 用户空间坐标
 * （bottom-left origin），与 @cantoo/pdf-lib 绘制坐标一致，无需翻转。
 *
 * 算法：
 * - 行聚类：按 y 降序、x 升序排序后单遍归并（y 差 ≤ 0.5×行高视为同行），
 *   项间水平 gap 超阈值补空格
 * - 段落聚类：相邻行基线差 ≤ 1.7×字号 且缩进/字号无明显变化视为同段
 * - 过滤不可译段：字母数 < 2 / 中文占比 > 40%（避免重复翻译）
 * - 对齐启发：单行段水平中心与页面中心偏差 < 6% 页宽 → center
 *
 * 局限（MVP）：
 * - 旋转页（/Rotate）文本坐标保持原用户空间语义，与 pdf-lib 写入一致，但不做视觉旋转校正
 * - 表格按单元格独立成段；跨页段落按页独立处理
 */

/** 单个文本行（聚合后的 layout 单元） */
export interface LayoutLine {
  text: string;
  /** 左边界 x（PDF 坐标） */
  x: number;
  /** 基线 y（PDF 坐标） */
  y: number;
  width: number;
  /** 行高（约等于字号） */
  height: number;
  fontSize: number;
}

/** 可翻译文本段（段落） */
export interface TextSegment {
  /** 全文唯一 id（从 0 起） */
  id: number;
  /** 所属页码（1-based） */
  page: number;
  /** 段落文本（多行以空格连接） */
  text: string;
  /** 段落包围盒（PDF 坐标；y 为底部） */
  bbox: { x: number; y: number; width: number; height: number };
  /** 正文代表字号（行字号中位数） */
  fontSize: number;
  /** 行距（相邻行基线差中位数；单行段 = fontSize × 1.35） */
  leading: number;
  /** 原始行列表（译文回写时做白底覆盖用） */
  lines: LayoutLine[];
  /** 对齐方式（启发式判定） */
  align: 'left' | 'center';
}

/** 单页版面 */
export interface PageLayout {
  /** 页码（1-based） */
  pageNumber: number;
  /** 用户空间页面尺寸（来自 page.view） */
  width: number;
  height: number;
  segments: TextSegment[];
}

export interface ExtractLayoutOptions {
  /** 只处理这些页码（1-based；undefined = 全部） */
  pages?: number[];
  signal?: AbortSignal;
}

export interface LayoutExtractResult {
  pages: PageLayout[];
  totalPages: number;
}

// ─────────── pdfjs 最小类型垫片 ───────────

interface PdfjsTextItem {
  str?: string;
  width?: number;
  height?: number;
  transform?: number[];
  fontName?: string;
}

interface PdfjsPage {
  view: number[];
  rotate?: number;
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

/** 内部：带 bbox 的原始文本项 */
interface RawItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

// ─────────── 主入口 ───────────

/**
 * 提取 PDF 版面段落。
 * @param data PDF 字节（内部复制，调用方可复用）
 */
export async function extractLayoutSegments(
  data: Uint8Array,
  opts: ExtractLayoutOptions = {},
): Promise<LayoutExtractResult> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule;
  const bytes = new Uint8Array(data);
  const loadingTask = pdfjs.getDocument({ data: bytes });
  const doc = await loadingTask.promise;

  try {
    assertNotAborted(opts.signal);
    const totalPages = doc.numPages;
    const wanted = normalizePages(opts.pages, totalPages);
    const pages: PageLayout[] = [];
    let nextSegmentId = 0;

    for (const pageNumber of wanted) {
      assertNotAborted(opts.signal);
      const page = await doc.getPage(pageNumber);
      const view = page.view ?? [0, 0, 612, 792];
      const pageWidth = Math.abs(view[2] - view[0]);
      const pageHeight = Math.abs(view[3] - view[1]);

      const content = await page.getTextContent();
      const items = toRawItems(content.items);
      const lines = groupIntoLines(items);
      const segments = groupIntoParagraphs(lines, pageNumber, pageWidth, nextSegmentId);
      nextSegmentId += segments.length;

      pages.push({ pageNumber, width: pageWidth, height: pageHeight, segments });
    }

    return { pages, totalPages };
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

// ─────────── 纯函数（导出供单测） ───────────

/** 把 pdfjs items 规整为 RawItem 列表（过滤空串） */
export function toRawItems(items: PdfjsTextItem[]): RawItem[] {
  const out: RawItem[] = [];
  for (const it of items) {
    const str = it.str ?? '';
    if (!str.trim()) continue;
    const transform = it.transform ?? [1, 0, 0, 1, 0, 0];
    const fontSize = Math.abs(transform[3] ?? 0) || 10;
    out.push({
      str,
      x: transform[4] ?? 0,
      y: transform[5] ?? 0,
      width: it.width ?? Math.max(1, str.length * fontSize * 0.5),
      height: it.height ?? fontSize,
      fontSize,
    });
  }
  return out;
}

/**
 * 行聚类：按 y 降序、x 升序排序后单遍归并。
 * y 差 ≤ max(2, 0.5 × 行高) 视为同一行；项间 gap > 0.2×字号补空格。
 */
export function groupIntoLines(items: RawItem[]): LayoutLine[] {
  if (items.length === 0) return [];
  const sorted = items.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines: LayoutLine[] = [];
  let current: RawItem[] = [sorted[0]!];

  const flush = (): void => {
    if (current.length === 0) return;
    current.sort((a, b) => a.x - b.x);
    const first = current[0]!;
    const fontSizes = current.map((i) => i.fontSize).sort((a, b) => a - b);
    const fontSize = fontSizes[Math.floor(fontSizes.length / 2)]!;
    const height = Math.max(...current.map((i) => i.height), fontSize);

    let text = '';
    let prevRight: number | null = null;
    for (const item of current) {
      if (prevRight !== null) {
        const gap = item.x - prevRight;
        // 补空格 heuristic：明显间隔，或前项以空格结尾
        if (gap > fontSize * 0.2 || text.endsWith(' ')) text += ' ';
      }
      text += item.str;
      prevRight = item.x + item.width;
    }
    const right = Math.max(...current.map((i) => i.x + i.width));
    lines.push({
      text: text.replace(/\s+/g, ' ').trim(),
      x: first.x,
      y: first.y,
      width: right - first.x,
      height,
      fontSize,
    });
    current = [];
  };

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i]!;
    const head = current[0]!;
    const tolerance = Math.max(2, 0.5 * Math.max(item.height, head.height));
    if (Math.abs(item.y - head.y) <= tolerance) {
      current.push(item);
    } else {
      flush();
      current = [item];
    }
  }
  flush();
  return lines;
}

/**
 * 段落聚类：相邻行基线差 ≤ 1.7×字号 且缩进/字号无明显变化 → 同段。
 * 过滤不可译段（字母 < 2 / 中文占比 > 40%）。
 */
export function groupIntoParagraphs(
  lines: LayoutLine[],
  page: number,
  pageWidth: number,
  startId = 0,
): TextSegment[] {
  const paragraphs: LayoutLine[][] = [];
  let current: LayoutLine[] = [];

  const flush = (): void => {
    if (current.length > 0) paragraphs.push(current);
    current = [];
  };

  for (const line of lines) {
    if (current.length === 0) {
      current = [line];
      continue;
    }
    const prev = current[current.length - 1]!;
    const baselineGap = Math.abs(prev.y - line.y);
    const refSize = Math.max(prev.fontSize, line.fontSize, 1);
    const sameBlock =
      baselineGap <= refSize * 1.7 &&
      Math.abs(line.x - prev.x) <= refSize * 2.5 &&
      Math.abs(line.fontSize - prev.fontSize) <= refSize * 0.25;
    if (sameBlock) {
      current.push(line);
    } else {
      flush();
      current = [line];
    }
  }
  flush();

  const segments: TextSegment[] = [];
  let id = startId;
  for (const group of paragraphs) {
    const text = group.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
    if (!isTranslatable(text)) continue;

    const fontSizes = group.map((l) => l.fontSize).sort((a, b) => a - b);
    const fontSize = fontSizes[Math.floor(fontSizes.length / 2)]!;

    // 行距：相邻行基线差中位数（组内按 y 降序）
    const sortedByY = group.slice().sort((a, b) => b.y - a.y);
    const gaps: number[] = [];
    for (let i = 1; i < sortedByY.length; i++) {
      gaps.push(Math.abs(sortedByY[i - 1]!.y - sortedByY[i]!.y));
    }
    gaps.sort((a, b) => a - b);
    const leading = gaps.length > 0
      ? gaps[Math.floor(gaps.length / 2)]!
      : fontSize * 1.35;

    const left = Math.min(...group.map((l) => l.x));
    const right = Math.max(...group.map((l) => l.x + l.width));
    const top = Math.max(...group.map((l) => l.y + l.fontSize));
    const bottom = Math.min(...group.map((l) => l.y - l.fontSize * 0.3));

    const bbox = { x: left, y: bottom, width: right - left, height: top - bottom };

    // 居中启发：段水平中心与页中心偏差 < 6% 页宽
    const segCenter = bbox.x + bbox.width / 2;
    const centered = Math.abs(segCenter - pageWidth / 2) < pageWidth * 0.06;

    segments.push({
      id: id++,
      page,
      text,
      bbox,
      fontSize,
      leading,
      lines: group.map((l) => ({ ...l })),
      align: centered ? 'center' : 'left',
    });
  }
  return segments;
}

/** 是否值得翻译：至少 2 个字母，且中文占比不超过 40% */
export function isTranslatable(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  if (compact.length === 0) return false;
  const letters = (compact.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 2) return false;
  const cjk = (compact.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  if (cjk / compact.length > 0.4) return false;
  return true;
}

/** 已基本是中文的文档判定（工具前置校验用） */
export function looksPrimarilyChinese(segments: TextSegment[]): boolean {
  const sample = segments.slice(0, 40);
  if (sample.length === 0) return false;
  let cjk = 0;
  let latin = 0;
  for (const s of sample) {
    const compact = s.text.replace(/\s+/g, '');
    cjk += (compact.match(/[\u4e00-\u9fff]/g) ?? []).length;
    latin += (compact.match(/[A-Za-z]/g) ?? []).length;
  }
  const total = cjk + latin;
  return total > 0 && cjk / total > 0.5;
}

// ─────────── helpers ───────────

function normalizePages(pages: number[] | undefined, total: number): number[] {
  if (!pages || pages.length === 0) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const set = new Set<number>();
  for (const p of pages) {
    if (Number.isInteger(p) && p >= 1 && p <= total) set.add(p);
  }
  return [...set].sort((a, b) => a - b);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('layout extraction aborted');
    err.name = 'AbortError';
    throw err;
  }
}
