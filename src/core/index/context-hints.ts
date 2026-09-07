/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 上下文前缀注入 —— 纯函数块构建（对标"信息前置"机制）
 *
 * buildSystemPrompt 阶段把代码检索 / 知识库检索结果直接注入 system prompt，
 * 让 agent 首轮即可获得代码地图与知识条目，而非依赖自觉调用 search_codebase /
 * search_knowledge（弱模型场景下探索轮次多、上下文被噪声污染）。
 *
 * 本文件只做纯格式化（无 I/O）：检索、读盘由 panel 侧完成。
 */

/** 注入用命中条目（text 已由调用方填好） */
export interface HintHit {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

export interface BuildHintsOptions {
  /** 最多注入条数（code 默认 6，knowledge 默认 3） */
  maxHits?: number;
  /** 单条 text 最大字符数（code 默认 400，knowledge 默认 300），超限截断并标注 */
  maxCharsPerHit?: number;
  /** 分数小数点位数（默认 3） */
  scoreDigits?: number;
}

const CODE_DEFAULTS: Required<BuildHintsOptions> = {
  maxHits: 6,
  maxCharsPerHit: 400,
  scoreDigits: 3,
};

/** 截断 text 到 maxChars，超限加标注 */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n… (截断)';
}

function buildHintsBlock(
  tag: string,
  leading: string,
  query: string,
  hits: HintHit[],
  opts: Required<BuildHintsOptions>,
): string | undefined {
  if (!query || !query.trim()) return undefined;
  const usable = hits.filter((h) => h.text && h.text.trim().length > 0).slice(0, opts.maxHits);
  if (usable.length === 0) return undefined;

  const lines: string[] = [];
  lines.push(`<${tag}>`);
  lines.push(leading);
  usable.forEach((h, i) => {
    lines.push(
      `## ${i + 1}. score=${h.score.toFixed(opts.scoreDigits)} [${h.filePath}:${h.startLine}-${h.endLine}]`,
    );
    lines.push('```');
    lines.push(truncateText(h.text, opts.maxCharsPerHit));
    lines.push('```');
  });
  lines.push(`</${tag}>`);
  return lines.join('\n');
}

/**
 * 构建 `<code_hints>` 注入块：根据用户问题检索到的相关代码片段。
 * 空 query / 空 hits / 全部 text 为空 → undefined（零注入）。
 */
export function buildCodeHintsBlock(
  query: string,
  hits: HintHit[],
  opts?: BuildHintsOptions,
): string | undefined {
  return buildHintsBlock(
    'code_hints',
    '根据用户问题检索到的相关代码（仅供参考定位）：',
    query,
    hits,
    { ...CODE_DEFAULTS, ...opts },
  );
}

/**
 * 构建 `<knowledge_hints>` 注入块：私有知识库（.devseeker/knowledge/**\/*.md）命中。
 * 默认 3 条 / 单条 300 字符（知识片段较短、密度高）。
 */
export function buildKnowledgeHintsBlock(
  query: string,
  hits: HintHit[],
  opts?: BuildHintsOptions,
): string | undefined {
  const defaults: Required<BuildHintsOptions> = {
    maxHits: 3,
    maxCharsPerHit: 300,
    scoreDigits: 3,
  };
  return buildHintsBlock(
    'knowledge_hints',
    '私有知识库中与用户问题相关的条目（仅供参考定位）：',
    query,
    hits,
    { ...defaults, ...opts },
  );
}