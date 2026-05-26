/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Diff 工具函数（DESIGN §M11.1 Diff 预览 / §M15.3 回滚粒度）
 *
 * 职责：
 * - line-level diff（Myers/LCS）产出 unified-diff 格式字符串
 * - 只有 UI 渲染需求，不走 patch apply（apply 仍用 search_replace/write_file）
 *
 * 设计权衡（MVP）：
 * - 纯 JS 手写，不引入 `diff` 等 npm 包
 * - 采用 LCS 回溯法，时间 O(m·n) 空间 O(m·n)；m,n 分别为行数
 * - 文件很大时（> 2000 行）走 fallback：before 全 - / after 全 +
 * - 输出格式对齐 `diff -u` 简化版：
 *   ```
 *   --- a/<relPath>
 *   +++ b/<relPath>
 *   @@ -<beforeStart>,<beforeLen> +<afterStart>,<afterLen> @@
 *   <context/+/- lines>
 *   ```
 *
 * CRLF 处理：
 * - split(/\r?\n/) 保留跨平台一致性；输出 unified 用 '\n'
 */

const LCS_CELL_LIMIT = 500 * 500; // 超过此 cell 数走 fallback（避免大文件阻塞 Extension Host）
const CONTEXT_LINES = 3;

export interface DiffResult {
  unified: string;
  added: number;
  removed: number;
}

export interface DiffOptions {
  relPath: string;
  created?: boolean;
  deleted?: boolean;
}

/**
 * 生成 unified diff。
 * before/after 为 undefined 或空串时按 created/deleted 处理。
 */
export function makeUnifiedDiff(
  before: string | undefined,
  after: string | undefined,
  opts: DiffOptions,
): DiffResult {
  const beforeLines = before === undefined ? [] : splitLines(before);
  const afterLines = after === undefined ? [] : splitLines(after);

  const header = `--- a/${opts.relPath}\n+++ b/${opts.relPath}`;

  if (opts.created || before === undefined) {
    return {
      unified: [
        `--- /dev/null`,
        `+++ b/${opts.relPath}`,
        hunkHeader(0, 0, 1, afterLines.length),
        ...afterLines.map((l) => `+${l}`),
      ].join('\n'),
      added: afterLines.length,
      removed: 0,
    };
  }
  if (opts.deleted || after === undefined) {
    return {
      unified: [
        `--- a/${opts.relPath}`,
        `+++ /dev/null`,
        hunkHeader(1, beforeLines.length, 0, 0),
        ...beforeLines.map((l) => `-${l}`),
      ].join('\n'),
      added: 0,
      removed: beforeLines.length,
    };
  }

  const cells = beforeLines.length * afterLines.length;
  if (cells > LCS_CELL_LIMIT) {
    return fallbackFullDiff(beforeLines, afterLines, opts, header);
  }

  const ops = lcsDiff(beforeLines, afterLines);
  const hunks = collectHunks(ops, CONTEXT_LINES);
  if (hunks.length === 0) {
    return { unified: '', added: 0, removed: 0 };
  }

  const parts: string[] = [header];
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    parts.push(
      hunkHeader(h.beforeStart, h.beforeLen, h.afterStart, h.afterLen),
    );
    for (const line of h.lines) {
      parts.push(line);
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { unified: parts.join('\n'), added, removed };
}

// ─────────── internals ───────────

function splitLines(text: string): string[] {
  if (text === '') return [];
  const hasTrailing = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (hasTrailing && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function hunkHeader(bStart: number, bLen: number, aStart: number, aLen: number): string {
  const bs = bLen === 0 ? 0 : bStart;
  const as = aLen === 0 ? 0 : aStart;
  return `@@ -${bs},${bLen} +${as},${aLen} @@`;
}

type Op =
  | { kind: 'equal'; line: string }
  | { kind: 'del'; line: string }
  | { kind: 'add'; line: string };

/** LCS 矩阵 + 回溯，产出 op 序列 */
function lcsDiff(a: string[], b: string[]): Op[] {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS 长度
  const dp: number[][] = new Array(m + 1);
  for (let i = 0; i <= m; i += 1) {
    dp[i] = new Array<number>(n + 1).fill(0);
  }
  for (let i = 1; i <= m; i += 1) {
    const ai = a[i - 1]!;
    const row = dp[i]!;
    const prev = dp[i - 1]!;
    for (let j = 1; j <= n; j += 1) {
      row[j] = ai === b[j - 1]! ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    }
  }
  // 回溯
  const ops: Op[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1]! === b[j - 1]!) {
      ops.push({ kind: 'equal', line: a[i - 1]! });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      ops.push({ kind: 'del', line: a[i - 1]! });
      i -= 1;
    } else {
      ops.push({ kind: 'add', line: b[j - 1]! });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ kind: 'del', line: a[i - 1]! });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ kind: 'add', line: b[j - 1]! });
    j -= 1;
  }
  ops.reverse();
  return ops;
}

interface Hunk {
  beforeStart: number;
  beforeLen: number;
  afterStart: number;
  afterLen: number;
  lines: string[];
}

/**
 * 把 op 序列按 context=3 聚合为 hunk 数组。
 */
function collectHunks(ops: Op[], context: number): Hunk[] {
  const hunks: Hunk[] = [];
  let bIdx = 1; // 1-based
  let aIdx = 1;

  let i = 0;
  while (i < ops.length) {
    // 找到下一个非 equal 块
    while (i < ops.length && ops[i]!.kind === 'equal') {
      bIdx += 1;
      aIdx += 1;
      i += 1;
    }
    if (i >= ops.length) break;

    // hunk 开头：向前取 context 行
    const headStart = Math.max(0, i - context);
    const preContextCount = i - headStart;
    const hunkBeforeStart = bIdx - preContextCount;
    const hunkAfterStart = aIdx - preContextCount;

    const lines: string[] = [];
    let beforeLen = 0;
    let afterLen = 0;

    // 前置 context
    for (let k = headStart; k < i; k += 1) {
      lines.push(` ${ops[k]!.line}`);
      beforeLen += 1;
      afterLen += 1;
    }

    // 累积 del/add/equal，equal 连续超过 2*context 则 break hunk
    let trailingEqual = 0;
    while (i < ops.length) {
      const op = ops[i]!;
      if (op.kind === 'equal') {
        trailingEqual += 1;
        if (trailingEqual > 2 * context) {
          // 回退 context + 1 行尾
          for (let back = 0; back <= context; back += 1) {
            lines.pop();
            beforeLen -= 1;
            afterLen -= 1;
            bIdx -= 1;
            aIdx -= 1;
            i -= 1;
            trailingEqual -= 1;
          }
          // 吸收 context 尾巴：向前回到正确位置后 break
          break;
        }
        lines.push(` ${op.line}`);
        beforeLen += 1;
        afterLen += 1;
        bIdx += 1;
        aIdx += 1;
      } else if (op.kind === 'del') {
        trailingEqual = 0;
        lines.push(`-${op.line}`);
        beforeLen += 1;
        bIdx += 1;
      } else {
        trailingEqual = 0;
        lines.push(`+${op.line}`);
        afterLen += 1;
        aIdx += 1;
      }
      i += 1;
    }

    // 结尾去除多余 context（超过 context 的部分）
    while (lines.length > 0 && lines[lines.length - 1]!.startsWith(' ') && trailingEqual > context) {
      lines.pop();
      beforeLen -= 1;
      afterLen -= 1;
      bIdx -= 1;
      aIdx -= 1;
      trailingEqual -= 1;
    }

    hunks.push({
      beforeStart: hunkBeforeStart,
      beforeLen,
      afterStart: hunkAfterStart,
      afterLen,
      lines,
    });
  }
  return hunks;
}

function fallbackFullDiff(
  before: string[],
  after: string[],
  opts: DiffOptions,
  header: string,
): DiffResult {
  return {
    unified: [
      header,
      hunkHeader(1, before.length, 1, after.length),
      ...before.map((l) => `-${l}`),
      ...after.map((l) => `+${l}`),
    ].join('\n'),
    added: after.length,
    removed: before.length,
  };
}

// ─────────── Diff 截断（大文件保护） ───────────

/** webview 渲染的最大 hunk 数量（超过此数截断，防止 DOM 卡死） */
export const MAX_HUNKS_FOR_WEBVIEW = 30;
/** webview 渲染的最大 diff 行数（兜底限制） */
export const MAX_DIFF_LINES_FOR_WEBVIEW = 1000;

export interface TruncateResult {
  /** 截断后的 unified diff 文本 */
  unified: string;
  /** 是否发生了截断 */
  truncated: boolean;
  /** 原始 hunk 总数 */
  totalHunks: number;
  /** 保留的 hunk 数量 */
  shownHunks: number;
}

/**
 * 截断 unified diff 文本，防止推送到 webview 时 DOM 渲染卡死。
 * 策略：按 hunk 边界切割，只保留前 MAX_HUNKS_FOR_WEBVIEW 个 hunk。
 * 返回截断后的文本 + 元数据。
 */
export function truncateUnifiedDiff(unified: string): TruncateResult {
  const lines = unified.split('\n');
  const headerLines: string[] = [];
  const hunks: string[][] = [];
  let currentHunk: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      headerLines.push(line);
      continue;
    }
    if (line.startsWith('@@')) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = [line];
      continue;
    }
    if (currentHunk) {
      currentHunk.push(line);
    } else {
      // 没有在 hunk 内，属于 header 的一部分
      headerLines.push(line);
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  const totalHunks = hunks.length;
  if (totalHunks <= MAX_HUNKS_FOR_WEBVIEW) {
    // 无需截断
    return { unified, truncated: false, totalHunks, shownHunks: totalHunks };
  }

  // 截断：只保留前 MAX_HUNKS_FOR_WEBVIEW 个 hunk
  const shownHunks = MAX_HUNKS_FOR_WEBVIEW;
  const keptHunks = hunks.slice(0, shownHunks);
  const truncatedUnified = [
    ...headerLines,
    ...keptHunks.flat(),
    '',
    `... (diff truncated: ${totalHunks} hunks total, showing first ${shownHunks}. See editor for full changes)`,
  ].join('\n');

  return { unified: truncatedUnified, truncated: true, totalHunks, shownHunks };
}

