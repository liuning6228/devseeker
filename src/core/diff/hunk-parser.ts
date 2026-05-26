/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * hunk-parser —— 将 unified diff 文本解析为结构化 hunk 数组
 *
 * 职责：
 * - 解析 `@@ -oldStart,oldCount +newStart,newCount @@` 头
 * - 提取每行的类型（context / add / del）和文本（去掉前缀符号）
 * - 保留文件头（--- / +++）供上层使用
 *
 * 格式示例：
 * ```
 * --- a/src/foo.ts
 * +++ b/src/foo.ts
 * @@ -10,3 +10,4 @@
 *  context line
 * -deleted line
 * +added line
 *  context line
 * ```
 */

export interface HunkLine {
  type: 'context' | 'add' | 'del';
  /** 原始行文本（含前缀符号） */
  raw: string;
  /** 去掉前缀符号后的内容 */
  text: string;
}

export interface Hunk {
  /** hunk 在 diff 中的顺序索引 */
  index: number;
  /** @@ 头行后的可选标题（如函数名） */
  header: string;
  /** 旧文件起始行号（1-based） */
  oldStart: number;
  /** 旧文件涉及行数 */
  oldCount: number;
  /** 新文件起始行号（1-based） */
  newStart: number;
  /** 新文件涉及行数 */
  newCount: number;
  /** hunk 中的行 */
  lines: HunkLine[];
}

export interface ParsedDiff {
  /** 旧文件路径（diff 头中的 --- 行） */
  oldPath?: string;
  /** 新文件路径（diff 头中的 +++ 行） */
  newPath?: string;
  /** 解析出的所有 hunks */
  hunks: Hunk[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(unified: string): ParsedDiff {
  const lines = unified.split(/\r?\n/);
  // 去掉因模板字符串或文件末尾换行产生的空尾行
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const result: ParsedDiff = { hunks: [] };
  let currentHunk: Hunk | null = null;
  let hunkIndex = 0;

  for (const raw of lines) {
    // 文件头
    if (raw.startsWith('--- ')) {
      result.oldPath = raw.slice(4).split('\t')[0].trim();
      continue;
    }
    if (raw.startsWith('+++ ')) {
      result.newPath = raw.slice(4).split('\t')[0].trim();
      continue;
    }

    // Hunk 头
    const m = HUNK_HEADER_RE.exec(raw);
    if (m) {
      if (currentHunk) {
        result.hunks.push(currentHunk);
      }
      currentHunk = {
        index: hunkIndex++,
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newCount: m[4] ? parseInt(m[4], 10) : 1,
        header: (m[5] ?? '').trim(),
        lines: [],
      };
      continue;
    }

    // Hunk 内容行
    if (currentHunk) {
      if (raw.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', raw, text: raw.slice(1) });
      } else if (raw.startsWith('-')) {
        currentHunk.lines.push({ type: 'del', raw, text: raw.slice(1) });
      } else if (raw.startsWith(' ')) {
        currentHunk.lines.push({ type: 'context', raw, text: raw.slice(1) });
      } else if (raw === '\\ No newline at end of file') {
        // 忽略 "无换行符" 提示行
        continue;
      } else if (raw === '') {
        // 空行在 hunk 中视为上下文（前缀为空，但按上下文处理）
        currentHunk.lines.push({ type: 'context', raw: ' ', text: '' });
      }
      // 其他未知行忽略
    }
  }

  if (currentHunk) {
    result.hunks.push(currentHunk);
  }

  return result;
}

/** 计算 hunk 的统计：新增行数、删除行数 */
export function hunkStats(hunk: Hunk): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of hunk.lines) {
    if (line.type === 'add') added++;
    if (line.type === 'del') removed++;
  }
  return { added, removed };
}
