/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * BingProvider —— Microsoft Bing Web Search API 适配（W8.11）
 *
 * 来源：DESIGN §M12.4（备选 provider）
 *
 * API：GET https://api.bing.microsoft.com/v7.0/search?q=<q>&count=<n>&freshness=<f>
 * Headers: Ocp-Apim-Subscription-Key: <apiKey>
 *
 * 参考：https://learn.microsoft.com/en-us/bing/search-apis/bing-web-search/reference/query-parameters
 *
 * freshness 映射：Day / Week / Month（Bing 官方仅支持这三档；Year / NoLimit → 不传参数）
 */

import type {
  FetchImpl,
  ISearchProvider,
  ProbeResult,
  SearchResultItem,
  SearchWebArgs,
  SearchWebResult,
} from './types.js';

export interface BingProviderOptions {
  apiKey: string;
  endpoint?: string;
  fetchImpl?: FetchImpl;
  /** 市场码，如 'zh-CN'/'en-US'，默认基于 language auto 推断 */
  market?: string;
}

const DEFAULT_ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search';

function mapFreshness(t: SearchWebArgs['timeRange']): string | undefined {
  switch (t) {
    case 'OneDay':
      return 'Day';
    case 'OneWeek':
      return 'Week';
    case 'OneMonth':
      return 'Month';
    default:
      return undefined;
  }
}

function inferMarket(lang: SearchWebArgs['language']): string {
  if (lang === 'zh') return 'zh-CN';
  if (lang === 'en') return 'en-US';
  return 'zh-CN';
}

export class BingProvider implements ISearchProvider {
  readonly id = 'bing' as const;
  readonly requiresKey = true;

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchImpl;
  private readonly defaultMarket: string | undefined;

  constructor(opts: BingProviderOptions) {
    this.apiKey = opts.apiKey;
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchImpl);
    this.defaultMarket = opts.market;
  }

  async search(args: SearchWebArgs, signal?: AbortSignal): Promise<SearchWebResult> {
    const start = Date.now();
    const topK = Math.max(1, Math.min(args.topK ?? 5, 10));
    const q = args.site ? `${args.query} site:${args.site}` : args.query;
    const market = this.defaultMarket ?? inferMarket(args.language);

    const url = new URL(this.endpoint);
    url.searchParams.set('q', q);
    url.searchParams.set('count', String(topK));
    url.searchParams.set('mkt', market);
    url.searchParams.set('responseFilter', 'Webpages');
    const fresh = mapFreshness(args.timeRange);
    if (fresh) url.searchParams.set('freshness', fresh);

    let items: SearchResultItem[] = [];
    try {
      const resp = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          'Ocp-Apim-Subscription-Key': this.apiKey,
          Accept: 'application/json',
        },
        signal,
      });
      if (!resp.ok) {
        return { results: [], provider: this.id, tookMs: Date.now() - start };
      }
      const data = (await resp.json()) as {
        webPages?: { value?: Array<Record<string, unknown>> };
      };
      const values = data.webPages?.value ?? [];
      items = values.slice(0, topK).map((r) => ({
        title: String(r.name ?? ''),
        url: String(r.url ?? ''),
        snippet: String(r.snippet ?? '').slice(0, 300),
        publishedAt:
          typeof r.dateLastCrawled === 'string' ? r.dateLastCrawled : undefined,
      }));
    } catch {
      // 网络失败 → 空结果
    }

    return { results: items, provider: this.id, tookMs: Date.now() - start };
  }

  async probe(): Promise<ProbeResult> {
    if (!this.apiKey) return { ok: false, detail: '未配置 Bing API Key' };
    try {
      const r = await this.search({ query: 'hello', topK: 1 });
      return r.results.length > 0
        ? { ok: true }
        : { ok: false, detail: 'Bing 返回空结果' };
    } catch (e) {
      return { ok: false, detail: String(e) };
    }
  }
}
