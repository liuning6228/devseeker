/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PDF 译文回写 —— 折行、字号适配与绘制（translate_pdf 的版面绘制层）。
 *
 * 策略（段落级重排）：
 * 1. 对每个已翻译段落，用白色矩形逐行覆盖原文行框（精确到行，最小化对图片/图形的误盖）
 * 2. 在段落块原位重绘中文译文：首行基线对齐原文首行，行距沿用段落 leading，
 *    左对齐用原 x、居中用原中心
 * 3. 折行：CJK 逐字断行、ASCII 单词整体不拆；字号自适配（按 0.92 递减，下限 6pt），
 *    直至行数不超过 maxLines（≈ 原行数 + 1，允许标题类单行段扩展到两行）
 *
 * 纯函数（wrapCjkLines / fitTextBlock）与绘制分离，便于单测。
 */

import type { Color, PDFFont, PDFPage } from '@cantoo/pdf-lib';
import type { TextSegment } from './layout.js';

/** 字体度量接口（@cantoo/pdf-lib 的 PDFFont 满足；单测可注入 fake） */
export interface TextMeasurer {
  widthOfTextAtSize(text: string, size: number): number;
}

/** 折行与字号适配参数 */
export interface FitTextOptions {
  /** 可用宽度（pt） */
  boxW: number;
  /** 原段落高度（pt） */
  boxH: number;
  /** 原字号（pt，自适配起点） */
  fontSize: number;
  /** 原行距（pt） */
  leading: number;
  /** 字号下限（默认 6pt） */
  minSize?: number;
  /** 行数上限（默认按 boxH/leading + 1 估算；调用方可按到下一段的空间收紧） */
  maxLines?: number;
  measure: TextMeasurer;
}

/** 适配结果 */
export interface FitTextResult {
  fontSize: number;
  leading: number;
  lines: string[];
}

/** 绘制参数 */
export interface PaintOptions {
  /** 译文颜色（默认黑色），Color 由 @cantoo/pdf-lib 的 rgb() 创建 */
  color?: Color;
}

/**
 * 逐字符/逐词折行。
 * - CJK 字符（含全角标点）任意位置可断
 * - ASCII 单词整体不拆（超长单词超宽时强制按字符拆）
 * - 换行处的空格丢弃
 */
export function wrapCjkLines(
  text: string,
  maxWidth: number,
  size: number,
  measure: TextMeasurer,
): string[] {
  if (!text) return [];
  const tokens = tokenizeForWrap(text);
  const lines: string[] = [];
  let current = '';
  let pendingSpace = false;

  for (const token of tokens) {
    if (token === ' ') {
      if (current) pendingSpace = true;
      continue;
    }

    // 放不进当前行：收行
    if (current && measure.widthOfTextAtSize(current + (pendingSpace ? ' ' : '') + token, size) > maxWidth) {
      // 收尾标点避头：留在当前行（允许微小溢出），避免标点独占一行
      if (token.length === 1 && NO_LINE_START.has(token)) {
        current += token;
        pendingSpace = false;
        continue;
      }
      lines.push(current);
      current = '';
      pendingSpace = false;
    }

    if (current) {
      current += (pendingSpace ? ' ' : '') + token;
      pendingSpace = false;
    } else if (measure.widthOfTextAtSize(token, size) <= maxWidth) {
      current = token;
    } else {
      // 超长 token（比整行还宽）：强制逐字符拆
      let buf = '';
      for (const ch of token) {
        if (buf && measure.widthOfTextAtSize(buf + ch, size) > maxWidth) {
          lines.push(buf);
          buf = ch;
        } else {
          buf += ch;
        }
      }
      current = buf;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * 字号自适配：从原字号起尝试，0.92 递减（下限 minSize），
 * 使折行数不超过 maxLines（默认 = 原行数 + 1，最少 2；调用方可用 maxLines 收紧到
 * 到下一段实际可用空间）。
 */
export function fitTextBlock(text: string, opts: FitTextOptions): FitTextResult {
  const minSize = opts.minSize ?? 6;
  // 行距比例来自原段落（clamp 到 1.05-1.8，避免过密/过疏）
  const ratio = clamp(
    opts.fontSize > 0 ? opts.leading / opts.fontSize : 1.35,
    1.05,
    1.8,
  );
  const origLines = Math.max(1, Math.round(opts.boxH / Math.max(opts.leading, 1)));
  const maxLines = opts.maxLines ?? Math.max(2, origLines + 1);

  let size = Math.max(minSize, opts.fontSize);
  for (;;) {
    const lines = wrapCjkLines(text, opts.boxW, size, opts.measure);
    if (lines.length <= maxLines || size <= minSize) {
      return { fontSize: size, leading: size * ratio, lines };
    }
    size = Math.max(minSize, size * 0.92);
  }
}

/**
 * 把译文绘制到页面。
 *
 * 两阶段绘制（关键顺序）：
 * 1. 先对所有已翻译段画白底覆盖矩形（行级精确覆盖原文）
 * 2. 再统一绘制译文——避免后画段的白底盖住前画段溢出的译文
 *
 * 行数约束：每段译文允许的最大行数按「到下一段首行上沿的实际空间」计算，
 * 防止译文溢出闯入下一段区域（末段无下一段时允许适度扩展）。
 * `translations` 中不存在的段保持原文不动（未翻译/翻译失败）。
 *
 * 注：`@cantoo/pdf-lib` 通过动态 import 懒加载（不在扩展激活期 require）。
 */
export async function paintTranslatedSegments(
  page: PDFPage,
  segments: readonly TextSegment[],
  translations: ReadonlyMap<number, string>,
  font: PDFFont,
  opts: PaintOptions = {},
): Promise<number> {
  const { rgb } = await import('@cantoo/pdf-lib');
  const color = opts.color ?? rgb(0, 0, 0);
  const white = rgb(1, 1, 1);
  const ordered = segments
    .filter((seg) => (translations.get(seg.id) ?? '').trim().length > 0)
    .slice()
    .sort((a, b) => b.bbox.y - a.bbox.y);
  if (ordered.length === 0) return 0;

  // 阶段 1：白底覆盖（行级精确）
  for (const seg of ordered) {
    for (const line of seg.lines) {
      const padX = line.fontSize * 0.25;
      const padBottom = line.fontSize * 0.32;
      const padTop = line.fontSize * 0.28;
      page.drawRectangle({
        x: line.x - padX,
        y: line.y - padBottom,
        width: line.width + padX * 2,
        height: Math.max(line.height, line.fontSize) + padBottom + padTop,
        color: white,
      });
    }
  }

  // 阶段 2：统一绘制译文
  let painted = 0;
  for (let i = 0; i < ordered.length; i++) {
    const seg = ordered[i]!;
    const translation = translations.get(seg.id)!;
    const firstBaseline = seg.lines[0]?.y ?? seg.bbox.y + seg.bbox.height;
    const next = ordered[i + 1];

    // 到下一段的空间：下一段首行之上保留 1.1×字号 安全间距，超出即碰撞
    const origLines = Math.max(1, Math.round(seg.bbox.height / Math.max(seg.leading, 1)));
    const nextBaseline = next ? (next.lines[0]?.y ?? next.bbox.y) : 0;
    const maxLines = next
      ? Math.max(
          1,
          Math.floor(
            (firstBaseline - nextBaseline - seg.fontSize * 1.1) /
              Math.max(seg.leading, seg.fontSize),
          ) + 1,
        )
      : origLines + 3;

    const fit = fitTextBlock(translation, {
      boxW: seg.bbox.width,
      boxH: seg.bbox.height,
      fontSize: seg.fontSize,
      leading: seg.leading,
      maxLines,
      measure: font,
    });
    const left = seg.bbox.x;

    fit.lines.forEach((textLine, k) => {
      const y = firstBaseline - k * fit.leading;
      const x = seg.align === 'center'
        ? left + (seg.bbox.width - font.widthOfTextAtSize(textLine, fit.fontSize)) / 2
        : left;
      page.drawText(textLine, { x, y, size: fit.fontSize, font, color });
    });
    painted++;
  }
  return painted;
}

// ─────────── helpers ───────────

/** 切分折行 token：CJK 单字 / ASCII 词（含内部数字与标点）/ 空格 */
function tokenizeForWrap(text: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  const flushBuf = (): void => {
    if (buf) {
      tokens.push(buf);
      buf = '';
    }
  };

  for (const ch of text) {
    if (isCjkChar(ch)) {
      flushBuf();
      tokens.push(ch);
    } else if (ch === ' ') {
      flushBuf();
      tokens.push(' ');
    } else {
      buf += ch;
    }
  }
  flushBuf();
  return tokens;
}

/** 不可作为行首的收尾标点（避头尾） */
const NO_LINE_START = new Set([
  '。', '，', '、', '；', '：', '！', '？', '）', '】', '》', '」', '』', '…', '％', '·',
  ',', '.', ';', ':', '!', '?', ')', ']', '}', '%',
]);

/** CJK 字符判定（含扩展 A 与全角标点区） */
function isCjkChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本区
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意
    (code >= 0xff00 && code <= 0xffef) // 全角形式
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
