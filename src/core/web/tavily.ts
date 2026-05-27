/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * TavilyProvider —— Tavily Search API 适配（W6b3）
 *
 * 来源：DESIGN §M12.4（海外 AI Agent 优化搜索引擎）
 *
 * API：POST https://api.tavily.com/search
 * Body: { api_key, query, max_results, search_depth, time_range, include_domains }
 *
 * 说明：
 * - 支持多 Key 池：优先使用 ApiKeyPool（多 key 随机选择 + failover），回退到单 key 模式
 * - 错误码映射：4xx/无效 key → WEB_SEARCH_PROVIDER_DOWN（调用方可兜底换 provider）
 * - 不抛异常，统一返回空结果 + tookMs（由 SearchWebTool 统一处理失败码）
 */

import type {
  FetchImpl,
  ISearchProvider,
  ProbeResult,
  SearchResultItem,
  SearchWebArgs,
  SearchWebResult,
} from './types.js';
import { ApiKeyPool } from './key-pool.js';

export interface TavilyProviderOptions {
  apiKey: string;
  endpoint?: string;
  fetchImpl?: FetchImpl;
  /** 多 Key 池（优先于单 apiKey） */
  keyPool?: ApiKeyPool;
}

const DEFAULT_ENDPOINT = 'https://api.tavily.com/search';

function mapTimeRange(t: SearchWebArgs['timeRange']): string | undefined {
  switch (t) {
    case 'OneDay':
      return 'day';
    case 'OneWeek':
      return 'week';
    case 'OneMonth':
      return 'month';
    case 'OneYear':
      return 'year';
    default:
      return undefined;
  }
}

export class TavilyProvider implements ISearchProvider {
  readonly id = 'tavily' as const;
  readonly requiresKey = true;

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchImpl;
  private readonly keyPool?: ApiKeyPool;

  constructor(opts: TavilyProviderOptions) {
    this.apiKey = opts.apiKey;
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchImpl);
    this.keyPool = opts.keyPool;
  }

  /** 获取当前使用的 Key（多 key 模式随机选择，单 key 模式返回固定 key） */
  private pickKey(): string {
    if (this.keyPool && this.keyPool.hasAvailableKeys()) {
      return this.keyPool.pick() ?? this.apiKey;
    }
    return this.apiKey;
  }

  async search(args: SearchWebArgs, signal?: AbortSignal): Promise<SearchWebResult> {
    const start = Date.now();
    const topK = Math.max(1, Math.min(args.topK ?? 5, 10));
    const query = args.site ? `${args.query} site:${args.site}` : args.query;

    const usedKey = this.pickKey();

    const body: Record<string, unknown> = {
      api_key: usedKey,
      query,
      max_results: topK,
      search_depth: 'basic',
      include_answer: false,
    };
    const tr = mapTimeRange(args.timeRange);
    if (tr) body.time_range = tr;

    let items: SearchResultItem[] = [];
    let failed = false;
    try {
      const resp = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        failed = true;
        // 报告 key 失败
        this.keyPool?.reportFailure(usedKey);
        // 如果有其他可用 key，尝试 failover 一次
        if (this.keyPool && this.keyPool.hasAvailableKeys()) {
          const retryKey = this.keyPool.pick();
          if (retryKey && retryKey !== usedKey) {
            const retryBody = { ...body, api_key: retryKey };
            try {
              const retryResp = await this.fetchImpl(this.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(retryBody),
                signal,
              });
              if (retryResp.ok) {
                const data = (await retryResp.json()) as { results?: Array<Record<string, unknown>> };
                items = (data.results ?? []).slice(0, topK).map((r) => ({
                  title: String(r.title ?? ''),
                  url: String(r.url ?? ''),
                  snippet: String(r.content ?? r.snippet ?? '').slice(0, 300),
                  publishedAt: typeof r.published_date === 'string' ? r.published_date : undefined,
                  score: typeof r.score === 'number' ? r.score : undefined,
                }));
                this.keyPool.reportSuccess(retryKey);
                failed = false;
              } else {
                this.keyPool.reportFailure(retryKey);
              }
            } catch {
              this.keyPool.reportFailure(retryKey);
            }
          }
        }
        if (failed) {
          return { results: [], provider: this.id, tookMs: Date.now() - start };
        }
      }
      if (!failed) {
        const data = (await resp.json()) as { results?: Array<Record<string, unknown>> };
        items = (data.results ?? []).slice(0, topK).map((r) => ({
          title: String(r.title ?? ''),
          url: String(r.url ?? ''),
          snippet: String(r.content ?? r.snippet ?? '').slice(0, 300),
          publishedAt: typeof r.published_date === 'string' ? r.published_date : undefined,
          score: typeof r.score === 'number' ? r.score : undefined,
        }));
        this.keyPool?.reportSuccess(usedKey);
      }
    } catch {
      // 网络失败 → 空结果；由 SearchWebTool 统一处理兜底
      this.keyPool?.reportFailure(usedKey);
    }

    return { results: items, provider: this.id, tookMs: Date.now() - start };
  }

  async probe(): Promise<ProbeResult> {
    if (!this.apiKey && !(this.keyPool && this.keyPool.hasAvailableKeys())) {
      return { ok: false, detail: '未配置 Tavily API Key' };
    }
    try {
      const r = await this.search({ query: 'ping', topK: 1 });
      return r.results.length > 0 ? { ok: true } : { ok: false, detail: 'Tavily 返回空结果' };
    } catch (e) {
      return { ok: false, detail: String(e) };
    }
  }

  /** 获取 Key 池（供外部重激活操作使用） */
  getKeyPool(): ApiKeyPool | undefined {
    return this.keyPool;
  }
}
