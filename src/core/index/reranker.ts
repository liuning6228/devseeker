/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W11.7 · Reranker —— 基于路径/关键词的重排 fallback
 *
 * 设计目标：
 * - 不依赖外部重排模型，纯本地、0 网络、O(n*k) 成本可控。
 * - 用于对 `CodebaseIndex.search` 输出做二次打分：拉高与查询关键词
 *   在路径/正文中重合度高的候选，抑制纯向量命中但实际无关的噪声。
 *
 * 评分公式：
 *   finalScore = baseScore * (1 + pathBoost + textBoost) * penaltyFactor
 * 其中：
 *   pathBoost = 0.30 * 每个命中关键词（上限 0.60）
 *   textBoost = min(0.50, 0.05 * 关键词在文本中出现次数)
 *   penaltyFactor：路径含 "test"/"spec" 时 ×0.90（除非查询本身带这些词）
 *
 * 约束：
 * - 关键词最小长度 2；停用词剔除；中英文按空白/标点切分。
 * - 输入顺序无关，返回按 finalScore 降序。
 */

export interface Rankable {
  filePath: string;
  text: string;
  score: number;
}

export interface RerankOptions {
  /** 关键词最小长度，默认 2 */
  minKeywordLen?: number;
  /** 最终返回 top-N；默认保留全部 */
  topK?: number;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'is', 'are',
  'was', 'were', 'be', 'been', 'at', 'by', 'with', 'from', 'that', 'this',
  'it', 'as', 'how', 'what', 'where', 'why', 'when', 'do', 'does', 'did',
  '的', '是', '在', '和', '与', '了', '吗', '呢', '一个', '怎么', '如何',
]);

/** 从查询字符串中抽取关键词（小写化，去停用词，去重） */
export function extractKeywords(query: string, minLen = 2): string[] {
  const lower = query.toLowerCase();
  // 非字母数字（含 CJK）即切分
  const raw = lower.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of raw) {
    if (w.length < minLen) continue;
    if (STOPWORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** 统计 needle 在 hay 中出现次数（简单 indexOf 滑动，无正则）。 */
function countOccurrences(hay: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

/**
 * 对候选列表做关键词/路径重排。
 * 不修改入参；返回新数组。
 */
export function keywordRerank<T extends Rankable>(
  query: string,
  candidates: readonly T[],
  opts: RerankOptions = {},
): T[] {
  const keywords = extractKeywords(query, opts.minKeywordLen ?? 2);
  if (keywords.length === 0 || candidates.length === 0) {
    return candidates.slice().sort((a, b) => b.score - a.score);
  }

  const queryHasTestWord = keywords.some((k) => k === 'test' || k === 'spec');

  const scored = candidates.map((c) => {
    const pathLower = c.filePath.toLowerCase();
    const textLower = c.text.toLowerCase();

    // path boost：每个关键词命中一次路径，记 +0.30（封顶 0.60）
    let pathHits = 0;
    for (const kw of keywords) {
      if (pathLower.includes(kw)) pathHits++;
    }
    const pathBoost = Math.min(0.6, 0.3 * pathHits);

    // text boost：统计所有关键词在正文的出现次数
    let textOcc = 0;
    for (const kw of keywords) {
      textOcc += countOccurrences(textLower, kw);
    }
    const textBoost = Math.min(0.5, 0.05 * textOcc);

    // test 目录略降权，除非用户明确问 test
    const isTest =
      !queryHasTestWord &&
      /(^|[\\/])(tests?|specs?|__tests__)([\\/]|$)|\.test\.|\.spec\./.test(pathLower);
    const penalty = isTest ? 0.9 : 1.0;

    const finalScore = c.score * (1 + pathBoost + textBoost) * penalty;
    return { cand: c, finalScore };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  const topN = opts.topK !== undefined ? scored.slice(0, opts.topK) : scored;
  return topN.map((s) => ({ ...s.cand, score: s.finalScore }));
}
