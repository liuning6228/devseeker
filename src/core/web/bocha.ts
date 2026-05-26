/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * BochaProvider —— 博查 Search API 适配（W6b3）
 *
 * 来源：DESIGN §M12.4（国内场景首选）
 *
 * API：POST https://api.bochaai.com/v1/web-search
 * Headers: Authorization: Bearer <apiKey>
 * Body: { query, freshness, summary, count }
 *
 * freshness 映射：oneDay / oneWeek / oneMonth / oneYear / noLimit（博查官方大小写）
 *
 * 支持多 Key 池：优先使用 ApiKeyPool（多 key 随机选择 + failover），回退到单 key 模式
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

export interface BochaProviderOptions {
  apiKey: string;
  endpoint?: string;
  fetchImpl?: FetchImpl;
  /** 多 Key 池（优先于单 apiKey） */
  keyPool?: ApiKeyPool;
}

const DEFAULT_ENDPOINT = 'https://api.bochaai.com/v1/web-search';

function mapFreshness(t: SearchWebArgs['timeRange']): string | undefined {
  switch (t) {
    case 'OneDay':
      return 'oneDay';
    case 'OneWeek':
      return 'oneWeek';
    case 'OneMonth':
      return 'oneMonth';
    case 'OneYear':
      return 'oneYear';
    case 'NoLimit':
      return 'noLimit';
    default:
      return undefined;
  }
}

export class BochaProvider implements ISearchProvider {
  readonly id = 'bocha' as const;
  readonly requiresKey = true;

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchImpl;
  private readonly keyPool?: ApiKeyPool;

  constructor(opts: BochaProviderOptions) {
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

    const body: Record<string, unknown> = { query, count: topK, summary: true };
    const fresh = mapFreshness(args.timeRange);
    if (fresh) body.freshness = fresh;

    let items: SearchResultItem[] = [];
    let failed = false;
    try {
      const resp = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${usedKey}`,
        },
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
            try {
              const retryResp = await this.fetchImpl(this.endpoint, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${retryKey}`,
                },
                body: JSON.stringify(body),
                signal,
              });
              if (retryResp.ok) {
                const data = (await retryResp.json()) as {
                  data?: { webPages?: { value?: Array<Record<string, unknown>> } };
                };
                const values = data.data?.webPages?.value ?? [];
                items = values.slice(0, topK).map((r) => ({
                  title: String(r.name ?? r.title ?? ''),
                  url: String(r.url ?? ''),
                  snippet: String(r.summary ?? r.snippet ?? '').slice(0, 300),
                  publishedAt: typeof r.datePublished === 'string' ? r.datePublished : undefined,
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
        const data = (await resp.json()) as {
          data?: { webPages?: { value?: Array<Record<string, unknown>> } };
        };
        const values = data.data?.webPages?.value ?? [];
        items = values.slice(0, topK).map((r) => ({
          title: String(r.name ?? r.title ?? ''),
          url: String(r.url ?? ''),
          snippet: String(r.summary ?? r.snippet ?? '').slice(0, 300),
          publishedAt: typeof r.datePublished === 'string' ? r.datePublished : undefined,
        }));
        this.keyPool?.reportSuccess(usedKey);
      }
    } catch {
      // 网络失败 → 空结果
      this.keyPool?.reportFailure(usedKey);
    }

    return { results: items, provider: this.id, tookMs: Date.now() - start };
  }

  async probe(): Promise<ProbeResult> {
    if (!this.apiKey && !(this.keyPool && this.keyPool.hasAvailableKeys())) {
      return { ok: false, detail: '未配置博查 API Key' };
    }
    try {
      const r = await this.search({ query: '测试', topK: 1 });
      return r.results.length > 0 ? { ok: true } : { ok: false, detail: '博查返回空结果' };
    } catch (e) {
      return { ok: false, detail: String(e) };
    }
  }

  /** 获取 Key 池（供外部重激活操作使用） */
  getKeyPool(): ApiKeyPool | undefined {
    return this.keyPool;
  }
}
