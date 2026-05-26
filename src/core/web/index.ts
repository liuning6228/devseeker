/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Web Research 模块 barrel export（W6b3）
 */
export * from './types.js';
export { validateUrl } from './url-guard.js';
export type { UrlGuardOptions, UrlGuardResult } from './url-guard.js';
export { TavilyProvider } from './tavily.js';
export type { TavilyProviderOptions } from './tavily.js';
export { BochaProvider } from './bocha.js';
export type { BochaProviderOptions } from './bocha.js';
export { BingProvider } from './bing.js';
export type { BingProviderOptions } from './bing.js';
export { DuckDuckGoProvider, parseDdgHtml } from './duckduckgo.js';
export type { DuckDuckGoProviderOptions } from './duckduckgo.js';
export { ApiKeyPool, parseApiKeys } from './key-pool.js';
export { chineseCharRatio, pickProviders } from './selector.js';
export type { ProviderRegistry } from './selector.js';
export {
  extractRelevant,
  splitChunks,
  cosine,
  scoreByKeyword,
  tokenize,
  SKIP_MARKER,
} from './relevance.js';
export type { ExtractRelevantOptions, ExtractRelevantResult } from './relevance.js';
export { LruCache } from './cache.js';
export type { LruCacheOptions, LruEntry } from './cache.js';
export { RateLimiter } from './rate-limiter.js';
export type { RateLimiterOptions } from './rate-limiter.js';
export { isPdfContent, extractPdfText } from './pdf.js';
export type { PdfExtractResult } from './pdf.js';
