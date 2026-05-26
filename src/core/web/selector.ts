/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Provider Selector —— 按查询语言自动选择搜索引擎（W6b3）
 *
 * 来源：DESIGN §M12.4
 *
 * 策略：
 * - language = 'zh'   → 博查优先
 * - language = 'en'   → Tavily 优先
 * - language = 'auto' / 未传 → 查询中文字符比例 > 30% 走博查，否则 Tavily
 * - 首选不可用（未配 key / 未注册） → 尝试次选；都不可用 → 返回 undefined
 */

import type { ISearchProvider, SearchProviderId, SearchWebArgs } from './types.js';

const CJK_RE = /[\u3400-\u9fff]/;

/** 计算查询中 CJK 汉字字符占比（去除空白） */
export function chineseCharRatio(query: string): number {
  const cleaned = query.replace(/\s+/g, '');
  if (cleaned.length === 0) return 0;
  let cjk = 0;
  for (const ch of cleaned) {
    if (CJK_RE.test(ch)) cjk++;
  }
  return cjk / cleaned.length;
}

export interface ProviderRegistry {
  /** provider id → 实例（未注册的 key 缺失 = 不可用） */
  readonly providers: ReadonlyMap<SearchProviderId, ISearchProvider>;
  /** 用户配置的 defaultProvider；'auto' 走语言启发式 */
  readonly defaultProvider?: SearchProviderId | 'auto';
}

/**
 * 选择一个可用的 provider；返回 [首选, 次选?]。
 * 调用方先用首选搜；若空结果且次选存在，可兜底重试。
 */
export function pickProviders(
  args: SearchWebArgs,
  registry: ProviderRegistry,
): ISearchProvider[] {
  const { providers, defaultProvider = 'auto' } = registry;
  const ordered: SearchProviderId[] = [];

  // 1) 若用户显式配置了 defaultProvider（非 auto），首选它
  if (defaultProvider !== 'auto' && providers.has(defaultProvider)) {
    ordered.push(defaultProvider);
  }

  // 2) 语言启发式
  const lang = args.language ?? 'auto';
  const prefersZh =
    lang === 'zh' || (lang === 'auto' && chineseCharRatio(args.query) > 0.3);
  const seq: SearchProviderId[] = prefersZh
    ? ['bocha', 'tavily', 'bing', 'duckduckgo']
    : ['tavily', 'bocha', 'bing', 'duckduckgo'];
  for (const id of seq) {
    if (!ordered.includes(id) && providers.has(id)) ordered.push(id);
  }

  return ordered.map((id) => providers.get(id)!).filter(Boolean);
}
