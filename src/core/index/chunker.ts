/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 文本分块器（W3 批次 1）
 *
 * MVP 策略：按行滑窗切分（不依赖 tree-sitter）。
 * - 每 chunk ≤ `maxChars`（≈ tokens * 4，中文更少）
 * - chunk 间有 `overlapLines` 行重叠，避免语义被截断
 * - 记录原文件 startLine / endLine（1-based inclusive），用于结果定位
 *
 * 后续（W3 批次 2）可替换为 tree-sitter 语法感知切分，接口保持兼容。
 */

export interface ChunkOptions {
  /** 目标单 chunk 最大字符数（默认 1600，约 400 tokens） */
  maxChars?: number;
  /** 相邻 chunk 重叠行数（默认 2） */
  overlapLines?: number;
  /** 太短的 chunk 会与下一个合并；阈值（默认 40） */
  minChars?: number;
}

export interface TextChunk {
  /** 原始相对路径（透传） */
  filePath: string;
  /** 1-based，inclusive */
  startLine: number;
  /** 1-based，inclusive */
  endLine: number;
  /** chunk 文本内容（不含行号前缀） */
  text: string;
}

const DEFAULT_MAX_CHARS = 1600;
const DEFAULT_OVERLAP_LINES = 2;
const DEFAULT_MIN_CHARS = 40;

/**
 * 切分单文件为若干 chunk。
 */
export function chunkText(
  filePath: string,
  content: string,
  options: ChunkOptions = {},
): TextChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapLines = Math.max(0, options.overlapLines ?? DEFAULT_OVERLAP_LINES);
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;

  if (!content.trim()) {
    return [];
  }

  // 保留原始行切分；注意避免末尾空行重复计数
  const lines = content.split(/\r?\n/);
  const hasTrailingNewline = content.endsWith('\n');
  const effectiveLineCount = hasTrailingNewline ? lines.length - 1 : lines.length;
  if (effectiveLineCount <= 0) return [];

  const chunks: TextChunk[] = [];
  let cursor = 0; // 0-based 行游标

  while (cursor < effectiveLineCount) {
    let end = cursor;
    let charCount = 0;
    // 贪心：在不越过 maxChars 的前提下尽可能多塞行
    while (end < effectiveLineCount) {
      const lineLen = lines[end].length + 1; // +1 for newline
      if (charCount + lineLen > maxChars && end > cursor) {
        break;
      }
      charCount += lineLen;
      end++;
    }

    const text = lines.slice(cursor, end).join('\n');
    chunks.push({
      filePath,
      startLine: cursor + 1,
      endLine: end,
      text,
    });

    if (end >= effectiveLineCount) break;
    // 滑动游标：回退 overlapLines 做重叠；但必须至少前进 1 行防死循环
    const next = Math.max(cursor + 1, end - overlapLines);
    cursor = next;
  }

  // 合并尾部过短 chunk 到前一个
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    if (last.text.length < minChars) {
      const prev = chunks[chunks.length - 2];
      prev.text = `${prev.text}\n${last.text}`;
      prev.endLine = last.endLine;
      chunks.pop();
    }
  }

  return chunks;
}
