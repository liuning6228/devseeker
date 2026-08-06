/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * FusionSearcher —— 多路融合搜索（P3）
 *
 * 在现有检索模块之上构建统一的融合搜索层：
 *   - CodebaseIndex（语义向量）
 *   - Bm25CodebaseIndex（BM25 词法）
 *   - GraphIndex（调用图，P2 可选）
 *
 * 融合算法采用 Reciprocal Rank Fusion (RRF)：
 *   RRF_score(d) = Σ 1 / (k + rank_i(d))    // k = 60
 *
 * 查询路由根据查询特征动态选择激活哪些搜索路：
 *   - 语义搜索（CodebaseIndex）：始终激活
 *   - BM25（Bm25CodebaseIndex）：始终激活
 *   - 图索引（GraphIndex）：包含函数名/类名模式时激活
 *
 * 设计约束：
 *   - 各路搜索并行执行
 *   - 单路失败静默降级（不影响其他路）
 *   - 无图索引时自动退化为双路融合
 */

import type { SearchResult } from './codebase-index.js';
import { extractKeywords } from './reranker.js';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('index.fusion-searcher');

// ─────────── 公共类型 ───────────

/** 融合搜索单条结果 */
export interface FusionHit extends SearchResult {
  /** 该结果来自哪些搜索源（用于 UI 标记） */
  sources: string[];
  /** RRF 融合分数 */
  rrfScore: number;
}

/** 融合搜索完整返回 */
export interface FusionSearchResult {
  hits: FusionHit[];
  /** 实际激活的搜索源列表 */
  activeSources: string[];
  /** 各路原始命中数（诊断用） */
  sourceCounts: Record<string, number>;
}

/** 搜索源接口 —— 各路索引需实现此接口 */
export interface SearchSource {
  readonly name: string;
  search(query: string, topK: number): Promise<SearchResult[]>;
  /** 返回 > 0 表示该源就绪可用 */
  size(): number;
}

/** FusionSearcher 构造选项 */
export interface FusionSearcherOptions {
  /** RRF 常数 k，默认 60 */
  rrfK?: number;
  /** 每路搜索的候选数（比最终 topK 多一些以提高召回），默认 topK * 2 */
  perSourceMultiplier?: number;
}

// ─────────── RRF 核心算法 ───────────

/**
 * Reciprocal Rank Fusion
 *
 * 对多路搜索结果按排名融合：
 *   RRF_score(d) = Σ 1 / (k + rank_i(d))
 *
 * @param results  各路搜索结果 Map<sourceName, rankedResults>
 * @param k        RRF 常数（默认 60）
 * @returns 融合后的去重排序列表
 */
export function reciprocalRankFusion(
  results: Map<string, SearchResult[]>,
  k: number = 60,
): FusionHit[] {
  // docKey → { rrfScore, sources, bestResult }
  const aggregated = new Map<string, {
    rrfScore: number;
    sources: string[];
    result: SearchResult;
  }>();

  for (const [sourceName, ranked] of results) {
    for (let rank = 0; rank < ranked.length; rank++) {
      const doc = ranked[rank];
      const key = `${doc.filePath}:${doc.startLine}-${doc.endLine}`;

      const rrfContribution = 1.0 / (k + rank + 1); // rank 从 0 开始，+1 避免除零
      const existing = aggregated.get(key);

      if (existing) {
        existing.rrfScore += rrfContribution;
        if (!existing.sources.includes(sourceName)) {
          existing.sources.push(sourceName);
        }
        // 保留原始 score 较高的结果（用于展示）
        if (doc.score > existing.result.score) {
          existing.result = doc;
        }
      } else {
        aggregated.set(key, {
          rrfScore: rrfContribution,
          sources: [sourceName],
          result: doc,
        });
      }
    }
  }

  // 按 RRF 分数降序排列
  return Array.from(aggregated.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ rrfScore, sources, result }) => ({
      ...result,
      sources,
      rrfScore,
    }));
}

// ─────────── 查询路由 ───────────

/** 查询路由决策 */
export interface RouteDecision {
  /** 激活的搜索源名称列表 */
  sources: string[];
  /** 路由原因（诊断用） */
  reasons: string[];
}

/**
 * 根据查询特征决定激活哪些搜索源
 *
 * 规则：
 *   - codebase（语义向量）：始终激活
 *   - bm25（词法搜索）：始终激活
 *   - graph（调用图）：查询包含函数名/类名模式，或包含调用关系关键词时激活
 *   - knowledge（知识库）：查询包含文档/规范/说明类关键词时激活
 */
export function routeQuery(
  query: string,
  availableSources: Map<string, SearchSource>,
): RouteDecision {
  const sources: string[] = [];
  const reasons: string[] = [];

  // 语义搜索始终激活
  if (hasReadySource(availableSources, 'codebase')) {
    sources.push('codebase');
    reasons.push('always-on');
  }

  // BM25 始终激活
  if (hasReadySource(availableSources, 'bm25')) {
    sources.push('bm25');
    reasons.push('always-on');
  }

  // 图索引：结构性查询时激活
  if (hasReadySource(availableSources, 'graph') && isStructuralQuery(query)) {
    sources.push('graph');
    reasons.push('structural-query');
  }

  // 知识库：文档/规范/说明类查询时激活
  if (hasReadySource(availableSources, 'knowledge') && isDocumentationQuery(query)) {
    sources.push('knowledge');
    reasons.push('documentation-query');
  }

  return { sources, reasons };
}

/** 检查搜索源是否就绪（存在且 size > 0） */
function hasReadySource(sources: Map<string, SearchSource>, name: string): boolean {
  const source = sources.get(name);
  return source !== undefined && source.size() > 0;
}

/**
 * 判断查询是否为结构性查询（适合激活图索引）
 *
 * 信号：
 *   - 包含 PascalCase/camelCase 标识符（函数名/类名）
 *   - 包含方法调用模式（xxx.yyy( 或 xxx( ）
 *   - 包含调用关系关键词（caller/callee/调用/依赖/引用）
 */
function isStructuralQuery(query: string): boolean {
  const q = query.trim();

  // 调用关系关键词
  const structuralKeywords = /caller|callee|调用|被调|依赖|引用|implement|interface|extends|import/i;
  if (structuralKeywords.test(q)) return true;

  // 方法调用模式：identifier.identifier( 或 identifier(
  if (/\b\w+\.\w+\s*\(/.test(q) || /\b\w+\s*\(/.test(q)) return true;

  // PascalCase 标识符（类名/接口名）
  if (/\b[A-Z][a-z]+[A-Z]\w*\b/.test(q)) return true;

  return false;
}

/**
 * 判断查询是否为文档/规范类查询（适合激活知识库）
 *
 * 信号：
 *   - 包含文档/规范/说明/指南类关键词
 *   - 包含 how to / what is / 怎么 / 规范 等询问性表述
 */
function isDocumentationQuery(query: string): boolean {
  const q = query.trim().toLowerCase();

  // 文档/规范/说明类关键词
  const docKeywords = /规范|指南|说明|文档|手册|流程|约定|标准|readme|guide|spec|documentation|convention/i;
  if (docKeywords.test(q)) return true;

  // 询问性表述（怎么做/是什么/如何）
  const questionPatterns = /怎么做|是什么|如何|怎么配置|怎么用|what is|how to|how do/i;
  if (questionPatterns.test(q)) return true;

  return false;
}

// ─────────── FusionSearcher 主类 ───────────

export class FusionSearcher {
  private readonly sources = new Map<string, SearchSource>();
  private readonly rrfK: number;
  private readonly perSourceMultiplier: number;

  constructor(options: FusionSearcherOptions = {}) {
    this.rrfK = options.rrfK ?? 60;
    this.perSourceMultiplier = options.perSourceMultiplier ?? 2;
  }

  /** 注册搜索源 */
  registerSource(source: SearchSource): void {
    this.sources.set(source.name, source);
  }

  /** 移除搜索源 */
  removeSource(name: string): void {
    this.sources.delete(name);
  }

  /** 获取当前所有搜索源名称 */
  getSourceNames(): string[] {
    return Array.from(this.sources.keys());
  }

  /** 获取就绪的搜索源数量 */
  getReadySourceCount(): number {
    let count = 0;
    for (const source of this.sources.values()) {
      if (source.size() > 0) count++;
    }
    return count;
  }

  /**
   * 融合搜索
   *
   * @param query  搜索查询
   * @param topK   最终返回结果数
   * @returns 融合搜索结果
   */
  async search(query: string, topK: number = 10): Promise<FusionSearchResult> {
    if (!query.trim()) {
      return { hits: [], activeSources: [], sourceCounts: {} };
    }

    // 1. 查询路由
    const route = routeQuery(query, this.sources);
    if (route.sources.length === 0) {
      return { hits: [], activeSources: [], sourceCounts: {} };
    }

    // 2. 每路搜索的候选数（多取一些以提高融合召回）
    const perSourceK = Math.max(topK, Math.ceil(topK * this.perSourceMultiplier));

    // 3. 并行执行各路搜索
    const searchPromises = route.sources.map(async (sourceName) => {
      const source = this.sources.get(sourceName);
      if (!source || source.size() === 0) return { name: sourceName, results: [] };
      try {
        const results = await source.search(query, perSourceK);
        return { name: sourceName, results };
      } catch (e) {
        log.warn({ source: sourceName, err: (e as Error).message }, 'search source failed');
        return { name: sourceName, results: [] };
      }
    });

    const searchResults = await Promise.all(searchPromises);

    // 4. 构建 RRF 输入
    const rrfInput = new Map<string, SearchResult[]>();
    const sourceCounts: Record<string, number> = {};
    for (const { name, results } of searchResults) {
      rrfInput.set(name, results);
      sourceCounts[name] = results.length;
    }

    // 5. RRF 融合
    const fused = reciprocalRankFusion(rrfInput, this.rrfK);

    // 6. 截取 topK
    const hits = fused.slice(0, topK);

    return {
      hits,
      activeSources: route.sources,
      sourceCounts,
    };
  }
}
