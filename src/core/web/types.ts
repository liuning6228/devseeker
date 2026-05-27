/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Web Research 模块类型（W6b3）
 *
 * 来源：DESIGN §M12.3, §M12.4
 *
 * 说明：
 * - 冻结接口 SearchWebArgs / SearchWebResult / FetchContentArgs / FetchContentResult
 *   与 DESIGN §M12.3 完全一致
 * - ISearchProvider：可插拔搜索引擎适配层（Tavily / Bocha / Bing / DDG）
 */

export type SearchProviderId = 'tavily' | 'bocha' | 'bing' | 'duckduckgo';

export interface SearchWebArgs {
  query: string;
  topK?: number;
  timeRange?: 'OneDay' | 'OneWeek' | 'OneMonth' | 'OneYear' | 'NoLimit';
  site?: string;
  language?: 'zh' | 'en' | 'auto';
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  score?: number;
}

export interface SearchWebResult {
  results: SearchResultItem[];
  provider: SearchProviderId;
  tookMs: number;
}

/** ProbeResult（§M1.5 统一），Provider 自检结果 */
export interface ProbeResult {
  ok: boolean;
  detail?: string;
}

export interface ISearchProvider {
  readonly id: SearchProviderId;
  readonly requiresKey: boolean;
  search(args: SearchWebArgs, signal?: AbortSignal): Promise<SearchWebResult>;
  probe(): Promise<ProbeResult>;
}

export type FetchContentMode = 'readable' | 'raw' | 'structured';

export interface FetchContentArgs {
  url: string;
  query?: string;
  maxLength?: number;
  mode?: FetchContentMode;
}

export interface FetchContentResult {
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  contentType: string;
  links?: string[];
  truncated: boolean;
  tookMs: number;
}

/** 注入到 Provider / Tool 便于单测的 fetch 依赖（默认 globalThis.fetch） */
export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;
