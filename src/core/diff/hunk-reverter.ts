/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * hunk-reverter —— 基于 unified diff hunk 信息，revert 单段修改
 *
 * 职责：
 * - 读取当前文件
 * - 根据 hunk 的 newStart/newCount 定位修改区域
 * - 用旧内容（context + del）替换新内容（context + add）
 * - 写回文件
 *
 * 安全策略：
 * - 定位前验证当前文件中的 hunk 区域是否与预期匹配
 * - 不匹配时尝试用 context 行做模糊搜索（±5 行滑动窗口）
 * - 仍不匹配则报错，不修改文件
 *
 * 限制：
 * - 不支持同一 hunk 在文件中出现多次（罕见场景）
 * - 文件在 diff 生成后若被外部修改，可能定位失败
 */

import { promises as fs } from 'node:fs';
import type { Hunk, HunkLine } from './hunk-parser.js';

export interface RevertHunkResult {
  ok: boolean;
  message: string;
}

/**
 * Revert 单个 hunk。
 * @param filePath 当前文件的绝对路径
 * @param hunk 要 revert 的 hunk
 */
export async function revertHunk(filePath: string, hunk: Hunk): Promise<RevertHunkResult> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (e) {
    return { ok: false, message: `无法读取文件：${(e as Error).message}` };
  }

  const lines = content.split(/\r?\n/);
  // 注意：如果文件末尾没有换行符，split 后最后一行可能不是空串
  // 但我们按行处理，最后 join 时统一加 \n

  const pos = locateHunk(lines, hunk);
  if (pos === null) {
    return {
      ok: false,
      message: `无法在文件中定位 hunk #${hunk.index + 1}（文件可能已被外部修改）`,
    };
  }

  const { start, end } = pos;
  const revertedLines = buildRevertedHunk(hunk);

  const newLines = [...lines.slice(0, start), ...revertedLines, ...lines.slice(end)];

  // 保持原文件的换行风格
  const hasCRLF = content.includes('\r\n');
  const newContent = newLines.join(hasCRLF ? '\r\n' : '\n');

  try {
    await fs.writeFile(filePath, newContent, 'utf-8');
  } catch (e) {
    return { ok: false, message: `写入文件失败：${(e as Error).message}` };
  }

  return {
    ok: true,
    message: `Hunk #${hunk.index + 1} 已 revert（${hunk.newStart}-${hunk.newStart + hunk.newCount - 1} → 恢复 ${revertedLines.length} 行）`,
  };
}

interface HunkPosition {
  /** hunk 在文件中的起始行索引（0-based，inclusive） */
  start: number;
  /** hunk 在文件中的结束行索引（0-based，exclusive） */
  end: number;
}

/**
 * 在文件中定位 hunk 的位置。
 * 策略：
 * 1. 先用 newStart/newCount 做直接定位
 * 2. 验证该区域的行是否与 hunk 的 context+add 匹配
 * 3. 不匹配时，用所有 context 行做滑动窗口搜索（±SEARCH_WINDOW）
 */
function locateHunk(fileLines: string[], hunk: Hunk): HunkPosition | null {
  const SEARCH_WINDOW = 5;

  // 构造 hunk 在新文件中的预期行序列（context + add）
  const expectedNew: string[] = [];
  for (const line of hunk.lines) {
    if (line.type === 'context') expectedNew.push(line.text);
    else if (line.type === 'add') expectedNew.push(line.text);
    // del 行在新文件中不出现
  }

  // 策略 1：直接定位
  const directStart = hunk.newStart - 1; // 转 0-based
  const directEnd = directStart + hunk.newCount;
  if (
    directStart >= 0 &&
    directEnd <= fileLines.length &&
    linesMatch(fileLines, directStart, expectedNew)
  ) {
    return { start: directStart, end: directEnd };
  }

  // 策略 2：滑动窗口搜索
  // 提取 context 行作为锚点
  const contextTexts = hunk.lines
    .filter((l) => l.type === 'context')
    .map((l) => l.text);

  if (contextTexts.length === 0) {
    // 无上下文锚点，只能依赖直接定位，失败即放弃
    return null;
  }

  const searchStart = Math.max(0, directStart - SEARCH_WINDOW);
  const searchEnd = Math.min(fileLines.length - expectedNew.length + 1, directEnd + SEARCH_WINDOW);

  for (let i = searchStart; i <= searchEnd; i++) {
    if (linesMatch(fileLines, i, expectedNew)) {
      return { start: i, end: i + expectedNew.length };
    }
  }

  return null;
}

/** 验证 fileLines[offset..] 是否与 expected 序列匹配 */
function linesMatch(fileLines: string[], offset: number, expected: string[]): boolean {
  if (offset + expected.length > fileLines.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (fileLines[offset + i] !== expected[i]) return false;
  }
  return true;
}

/**
 * 根据 hunk 构建 revert 后的行序列。
 * 规则：
 * - context → 保留
 * - del → 恢复（在新文件中重新出现）
 * - add → 删除（在新文件中不出现）
 */
function buildRevertedHunk(hunk: Hunk): string[] {
  const out: string[] = [];
  for (const line of hunk.lines) {
    if (line.type === 'context' || line.type === 'del') {
      out.push(line.text);
    }
    // add 行被丢弃
  }
  return out;
}
