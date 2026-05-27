/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * fuzzy-match — 模糊匹配工具集
 *
 * 参考 Roo Code MultiSearchReplaceDiffStrategy 和 Cline constructNewFileContent 的
 * 多级 fallback 策略，为 search_replace 提供模糊匹配能力。
 *
 * 匹配级别（由严到宽）：
 * 0. 引号归一化匹配 — 直引号 ↔ 弯引号视为等价（§8.11.1）
 * 1. 精确匹配 — 原始字符串完全相同
 * 2. 行 trim 匹配 — 逐行 trim 后匹配（忽略行首尾空白差异）
 * 3. Levenshtein 模糊匹配 — 基于编辑距离的相似度匹配
 */

/**
 * 匹配结果
 */
export interface MatchResult {
  /** 是否匹配成功 */
  matched: boolean;
  /** 匹配在原文中的起始位置（-1 表示未匹配） */
  index: number;
  /** 匹配到的原始文本片段 */
  matchedText: string;
  /** 使用的匹配级别 */
  matchLevel: 'exact' | 'line-trim' | 'fuzzy' | 'quote-normalized';
  /** 相似度分数 (0-1)，精确匹配和行 trim 匹配为 1.0 */
  similarity: number;
}

/** 默认模糊匹配阈值（0-1，1 = 精确匹配） */
const DEFAULT_FUZZY_THRESHOLD = 0.9;

// ─────────── 0. 引号规范化（§8.11.1） ───────────

/**
 * Unicode 弯单引号集合（左/右）
 * U+2018 ' 左单引号
 * U+2019 ' 右单引号
 */
const CURLY_SINGLE = "'";

/**
 * Unicode 弯双引号集合（左/右）
 * U+201C " 左双引号
 * U+201D " 右双引号
 */
const CURLY_DOUBLE = '"';

/** 直单引号 U+0027 */
const STRAIGHT_SINGLE = "'";
/** 直双引号 U+0022 */
const STRAIGHT_DOUBLE = '"';

/** 判断字符是否是单引号（直或弯） */
function isSingleQuote(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code === 0x27 || code === 0x2018 || code === 0x2019;
}

/** 判断字符是否是双引号（直或弯） */
function isDoubleQuote(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code === 0x22 || code === 0x201c || code === 0x201d;
}

/** 判断字符是否是任意引号 */
function isQuote(ch: string): boolean {
  return isSingleQuote(ch) || isDoubleQuote(ch);
}

/** 将弯引号归一化为直引号 */
function normalizeQuoteChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code === 0x2018 || code === 0x2019) return STRAIGHT_SINGLE;
  if (code === 0x201c || code === 0x201d) return STRAIGHT_DOUBLE;
  return ch;
}

/**
 * 将所有 Unicode 弯引号归一化为直引号，用于匹配比较。
 * 不修改 new_string —— 匹配后再做样式 preserve。
 */
export function normalizeQuotes(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    result += normalizeQuoteChar(str[i]!);
  }
  return result;
}

/**
 * 保留文件原文的引号风格：
 * 遍历 actualOld（文件中实际匹配到的文本）与 newStr，
 * 对 newStr 中每个位置与 actualOld 对应的引号字符做样式保持。
 *
 * 算法：
 * 1. 对 actualOld 和 newStr 相同偏移位置的字符做引号匹配判断
 * 2. 若 newStr[i] 是直引号且 actualOld[i] 是弯引号 → 用 actualOld[i] 替换 newStr[i]
 * 3. 若 newStr[i] 是弯引号且 actualOld[i] 是直引号 → 用 actualOld[i] 替换 newStr[i]
 * 4. 若两者都是直引号但 actualOld[i] 是双引号、newStr[i] 是单引号 → 不替换
 *    （引号类型不同通常意味着不同语义，不是样式差异）
 * 5. 非引号字符不处理
 */
export function preserveQuoteStyle(actualOld: string, newStr: string): string {
  let result = '';
  const len = Math.min(actualOld.length, newStr.length);
  for (let i = 0; i < len; i++) {
    const oldCh = actualOld[i]!;
    const newCh = newStr[i]!;
    if (isQuote(newCh) && isQuote(oldCh)) {
      // 两者类型相同（单对单、双对双）→ 保留 old 风格
      if (isSingleQuote(newCh) === isSingleQuote(oldCh)) {
        result += oldCh; // 保留文件原文的引号字符
      } else {
        result += newCh; // 类型不同（单↔双），保留 newStr
      }
    } else {
      result += newCh;
    }
  }
  // 超出 actualOld 长度的 newStr 部分原样追加
  if (newStr.length > len) {
    result += newStr.slice(len);
  }
  return result;
}

// ─────────── 1. 精确匹配 ───────────

/**
 * 在 haystack 中查找 needle 的精确出现位置。
 * 返回所有出现位置的起始索引。
 */
export function exactMatch(haystack: string, needle: string): number[] {
  if (needle.length === 0) return []; // 空字符串不算匹配
  const indices: number[] = [];
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    indices.push(idx);
    idx += needle.length;
  }
  return indices;
}

// ─────────── 2. 行 trim 匹配 ─────────--

/**
 * 将文本按行 trim 后重组，用于行级空白差异容忍。
 * 保留行数结构，仅去除每行首尾空白。
 */
function lineTrim(text: string): string {
  return text.split('\n').map(line => line.trim()).join('\n');
}

/**
 * 行 trim 匹配：逐行 trim 后精确匹配。
 * 这能处理行首尾空白差异（缩进变化、trailing space 等），
 * 但不改变行数和行顺序。
 *
 * 返回匹配位置和原始文本片段。
 */
export function lineTrimMatch(
  haystack: string,
  needle: string,
): { index: number; matchedText: string; lineCount: number }[] {
  const haystackLines = haystack.split('\n');
  const needleLines = needle.split('\n');
  const needleTrimmed = lineTrim(needle);

  if (needleLines.length === 0 || needleLines.length > haystackLines.length) {
    return [];
  }

  const results: { index: number; matchedText: string; lineCount: number }[] = [];

  for (let i = 0; i <= haystackLines.length - needleLines.length; i++) {
    const chunk = haystackLines.slice(i, i + needleLines.length).join('\n');
    if (lineTrim(chunk) === needleTrimmed) {
      // 计算字符偏移
      let charIndex = 0;
      for (let j = 0; j < i; j++) {
        charIndex += haystackLines[j].length + 1; // +1 for \n
      }
      results.push({
        index: charIndex,
        matchedText: chunk,
        lineCount: needleLines.length,
      });
    }
  }

  return results;
}

// ─────────── 3. Levenshtein 模糊匹配 ───────────

/**
 * 计算两个字符串的 Levenshtein 编辑距离。
 * 使用动态规划，O(m*n) 时间和空间。
 * 对于大字符串（>5000 字符），使用滑动窗口优化空间到 O(min(m,n))。
 */
export function levenshteinDistance(a: string, b: string, maxDistance?: number): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Early termination: if length difference already exceeds maxDistance, no need to compute
  if (maxDistance !== undefined) {
    const lenDiff = Math.abs(a.length - b.length);
    if (lenDiff > maxDistance) {
      return maxDistance + 1;
    }
  }

  // 空间优化：使用两行 DP
  const prev = new Uint32Array(b.length + 1);
  const curr = new Uint32Array(b.length + 1);

  for (let j = 0; j <= b.length; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // 删除
        curr[j - 1] + 1,  // 插入
        prev[j - 1] + cost, // 替换
      );
      rowMin = Math.min(rowMin, curr[j]);
    }
    // Early termination: if best possible path in this row exceeds maxDistance, abort
    if (maxDistance !== undefined && rowMin > maxDistance) {
      return maxDistance + 1;
    }
    // swap
    const tmp = prev;
    prev.set(curr);
    curr.fill(0);
    curr[0] = 0;
  }

  return prev[b.length];
}

/**
 * 计算两个字符串的相似度（0-1，1 = 完全相同）。
 */
export function similarity(a: string, b: string, threshold?: number): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const maxLen = Math.max(a.length, b.length);
  // Compute max allowable distance based on threshold for early termination
  const maxDistance = threshold !== undefined ? Math.floor(maxLen * (1 - threshold)) : undefined;
  const dist = levenshteinDistance(a, b, maxDistance);
  if (maxDistance !== undefined && dist > maxDistance) {
    return 0;
  }
  return 1 - dist / maxLen;
}

/**
 * 在 haystack 中搜索与 needle 最相似的片段。
 * 使用滑动窗口策略，窗口大小 = needle 的行数。
 * 对于大文件，支持搜索范围限制以提高性能。
 *
 * @returns 最相似片段的 { index, matchedText, similarity }，未找到返回 null
 */
export function fuzzySearch(
  haystack: string,
  needle: string,
  options?: {
    threshold?: number;
    startLine?: number;
    endLine?: number;
  },
): { index: number; matchedText: string; similarity: number } | null {
  const threshold = options?.threshold ?? DEFAULT_FUZZY_THRESHOLD;
  const haystackLines = haystack.split('\n');
  const needleLines = needle.split('\n');

  if (needleLines.length === 0 || needleLines.length > haystackLines.length) {
    return null;
  }

  // Safety valve: skip fuzzy matching for very large inputs to avoid blocking the Extension Host
  const MAX_NEEDLE_CHARS = 3000;
  const MAX_HAYSTACK_LINES = 2000;
  if (needle.length > MAX_NEEDLE_CHARS || haystackLines.length > MAX_HAYSTACK_LINES) {
    return null;
  }

  const searchStart = options?.startLine ?? 0;
  const searchEnd = options?.endLine ?? haystackLines.length;
  const needleText = needle;

  let bestScore = 0;
  let bestIndex = -1;
  let bestMatch = '';

  // 滑动窗口搜索
  for (let i = searchStart; i <= Math.min(searchEnd, haystackLines.length) - needleLines.length; i++) {
    const endLine = Math.min(i + needleLines.length, haystackLines.length);
    const chunk = haystackLines.slice(i, endLine).join('\n');
    const score = similarity(chunk, needleText, threshold);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
      bestMatch = chunk;

      // 精确匹配即可提前返回
      if (score >= 1.0) break;
    }

    // 也检查 needleLines.length ± 1 行的窗口（处理行合并/拆分差异）
    for (const delta of [-1, 1]) {
      const windowSize = needleLines.length + delta;
      if (windowSize <= 0 || i + windowSize > haystackLines.length) continue;
      const chunk2 = haystackLines.slice(i, i + windowSize).join('\n');
      const score2 = similarity(chunk2, needleText, threshold);
      if (score2 > bestScore) {
        bestScore = score2;
        bestIndex = i;
        bestMatch = chunk2;
      }
    }
  }

  if (bestScore < threshold || bestIndex === -1) {
    return null;
  }

  // 计算字符偏移
  let charIndex = 0;
  for (let j = 0; j < bestIndex; j++) {
    charIndex += haystackLines[j].length + 1;
  }

  return {
    index: charIndex,
    matchedText: bestMatch,
    similarity: bestScore,
  };
}

// ─────────── 多级 fallback 匹配 ───────────

/**
 * 多级 fallback 匹配：精确 → 行 trim → Levenshtein 模糊
 *
 * @param haystack 被搜索的原文
 * @param needle 要查找的字符串
 * @param options.threshold 模糊匹配阈值（默认 0.9）
 * @param options.allowFuzzy 是否启用模糊匹配（默认 true）
 * @returns MatchResult
 */
export function multiLevelMatch(
  haystack: string,
  needle: string,
  options?: {
    threshold?: number;
    allowFuzzy?: boolean;
  },
): MatchResult {
  const threshold = options?.threshold ?? DEFAULT_FUZZY_THRESHOLD;
  const allowFuzzy = options?.allowFuzzy ?? true;

  // Level 1: 精确匹配
  const exactIndices = exactMatch(haystack, needle);
  if (exactIndices.length > 0) {
    return {
      matched: true,
      index: exactIndices[0],
      matchedText: needle,
      matchLevel: 'exact',
      similarity: 1.0,
    };
  }

  // Level 0.5: 引号归一化匹配（§8.11.1）
  // 在精确匹配失败后、行 trim 之前尝试引号归一化匹配
  const nHaystack = normalizeQuotes(haystack);
  const nNeedle = normalizeQuotes(needle);
  if (nHaystack !== haystack || nNeedle !== needle) {
    // 至少有一方包含弯引号，值得尝试
    const normalizedIndices = exactMatch(nHaystack, nNeedle);
    if (normalizedIndices.length === 1) {
      // 唯一匹配成功 → 从原始 haystack 中提取 matchedText
      const idx = normalizedIndices[0]!;
      const matchedText = haystack.slice(idx, idx + needle.length);
      // 若 new_string 有引号差异，用 preserveQuoteStyle 适配
      return {
        matched: true,
        index: idx,
        matchedText,
        matchLevel: 'quote-normalized',
        similarity: 1.0,
      };
    }
    if (normalizedIndices.length > 1) {
      // 多处匹配，不处理（让后续级别尝试）
    }
  }

  // Level 2: 行 trim 匹配
  const trimResults = lineTrimMatch(haystack, needle);
  if (trimResults.length === 1) {
    return {
      matched: true,
      index: trimResults[0].index,
      matchedText: trimResults[0].matchedText,
      matchLevel: 'line-trim',
      similarity: 1.0,
    };
  }
  if (trimResults.length > 1) {
    // 行 trim 匹配多处命中 — 无法确定唯一位置，跳过让模糊匹配处理
    // 但也返回信息，让调用方决定
  }

  // Level 3: Levenshtein 模糊匹配
  if (!allowFuzzy) {
    return {
      matched: false,
      index: -1,
      matchedText: '',
      matchLevel: 'exact',
      similarity: 0,
    };
  }

  const fuzzyResult = fuzzySearch(haystack, needle, { threshold });
  if (fuzzyResult) {
    return {
      matched: true,
      index: fuzzyResult.index,
      matchedText: fuzzyResult.matchedText,
      matchLevel: 'fuzzy',
      similarity: fuzzyResult.similarity,
    };
  }

  return {
    matched: false,
    index: -1,
    matchedText: '',
    matchLevel: 'exact',
    similarity: 0,
  };
}

/**
 * 统计精确匹配次数
 */
export function exactMatchCount(haystack: string, needle: string): number {
  return exactMatch(haystack, needle).length;
}
