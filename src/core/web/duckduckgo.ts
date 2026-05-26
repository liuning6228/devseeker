/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * DuckDuckGoProvider —— DuckDuckGo HTML 抓取 fallback provider（W8.11）
 *
 * 来源：DESIGN §M12.4（无需 API Key 的备选 provider）
 *
 * 策略：
 * - 请求 https://html.duckduckgo.com/html/?q=<query>
 * - 用正则从 HTML 中抽取结果项（避免引入 cheerio 等重依赖）
 * - 失败或返回空 → 空结果（上层会 fallback 到下一个 provider）
 *
 * 局限：
 * - 非官方 API，HTML 结构变化时可能解析失败
 * - DDG 有反爬策略，频繁请求会被限流（配合全局 RateLimiter 使用）
 * - 不支持精确 freshness（DDG HTML 端点接受 df=d/w/m）
 */

import type {
  FetchImpl,
  ISearchProvider,
  ProbeResult,
  SearchResultItem,
  SearchWebArgs,
  SearchWebResult,
} from './types.js';

export interface DuckDuckGoProviderOptions {
  endpoint?: string;
  fetchImpl?: FetchImpl;
}

const DEFAULT_ENDPOINT = 'https://html.duckduckgo.com/html/';

function mapFreshness(t: SearchWebArgs['timeRange']): string | undefined {
  switch (t) {
    case 'OneDay':
      return 'd';
    case 'OneWeek':
      return 'w';
    case 'OneMonth':
      return 'm';
    case 'OneYear':
      return 'y';
    default:
      return undefined;
  }
}

/**
 * 从 DDG HTML 结果页抽取搜索项。
 * 典型结构（简化）：
 *   <a class="result__a" href="/l/?uddg=<encoded-url>">Title</a>
 *   <a class="result__snippet" href="...">Snippet</a>
 * 或新版：
 *   <a class="result__a" href="https://example.com">Title</a>
 */
export function parseDdgHtml(html: string, topK: number): SearchResultItem[] {
  const items: SearchResultItem[] = [];

  // 匹配每个 result 块：包含 result__a（title + href）和 result__snippet
  const blockRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    if (items.length >= topK) break;
    const rawHref = m[1] ?? '';
    const titleHtml = m[2] ?? '';
    const snippetHtml = m[3] ?? '';
    const url = resolveDdgUrl(rawHref);
    if (!url) continue;
    const title = stripTags(titleHtml).trim();
    const snippet = stripTags(snippetHtml).trim().slice(0, 300);
    if (!title || !url) continue;
    items.push({ title, url, snippet });
  }

  return items;
}

/** DDG 新版 HTML href 形如 "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F..." */
function resolveDdgUrl(href: string): string | undefined {
  if (!href) return undefined;
  let h = href;
  if (h.startsWith('//')) h = 'https:' + h;
  try {
    const u = new URL(h);
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    // 若 href 本身就是绝对 url 且非 duckduckgo 跳转 → 直接返回
    if (u.hostname !== 'duckduckgo.com' && u.hostname !== 'html.duckduckgo.com') {
      return u.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export class DuckDuckGoProvider implements ISearchProvider {
  readonly id = 'duckduckgo' as const;
  readonly requiresKey = false;

  private readonly endpoint: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: DuckDuckGoProviderOptions = {}) {
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchImpl);
  }

  async search(args: SearchWebArgs, signal?: AbortSignal): Promise<SearchWebResult> {
    const start = Date.now();
    const topK = Math.max(1, Math.min(args.topK ?? 5, 10));
    const q = args.site ? `${args.query} site:${args.site}` : args.query;

    const body = new URLSearchParams();
    body.set('q', q);
    const fresh = mapFreshness(args.timeRange);
    if (fresh) body.set('df', fresh);

    let items: SearchResultItem[] = [];
    try {
      // DDG HTML 端点接受 POST 表单
      const resp = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':
            'Mozilla/5.0 (compatible; DualMind/0.1; +https://github.com/local/dualmind)',
          Accept: 'text/html',
        },
        body: body.toString(),
        signal,
      });
      if (!resp.ok) {
        return { results: [], provider: this.id, tookMs: Date.now() - start };
      }
      const html = await resp.text();
      items = parseDdgHtml(html, topK);
    } catch {
      // 网络失败 → 空结果
    }

    return { results: items, provider: this.id, tookMs: Date.now() - start };
  }

  async probe(): Promise<ProbeResult> {
    try {
      const r = await this.search({ query: 'hello world', topK: 1 });
      return r.results.length > 0
        ? { ok: true }
        : { ok: false, detail: 'DuckDuckGo 返回空结果' };
    } catch (e) {
      return { ok: false, detail: String(e) };
    }
  }
}
