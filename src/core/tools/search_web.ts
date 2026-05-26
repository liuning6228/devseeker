/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * search_web 工具（W6b3）
 *
 * 来源：DESIGN §M12.3.1
 *
 * 语义：
 * - 接受 query + topK/timeRange/site/language
 * - 依 selector 选 provider 顺序（博查/Tavily 互备）
 * - 首选空结果 → 尝试次选（最多 2 个）
 * - 全部失败 → ok=false + WEB_SEARCH_PROVIDER_DOWN
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';
import type { ProviderRegistry } from '../web/selector.js';
import { pickProviders } from '../web/selector.js';
import type { SearchWebArgs, SearchWebResult } from '../web/types.js';

export interface SearchWebToolDeps {
  getRegistry: () => ProviderRegistry;
}

const parameters = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '检索关键词或问题（必填）' },
    topK: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
    timeRange: {
      type: 'string',
      enum: ['OneDay', 'OneWeek', 'OneMonth', 'OneYear', 'NoLimit'],
    },
    site: { type: 'string', description: '限定站点，如 "github.com"' },
    language: { type: 'string', enum: ['zh', 'en', 'auto'], default: 'auto' },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

export class SearchWebTool implements ITool<SearchWebArgs, ToolResult> {
  readonly name = 'search_web';
  readonly description =
    'Search the web via Tavily (overseas) / Bocha (CN). Use during plan / debug / research phases to ground answers on up-to-date external sources. Returns title+url+snippet list, call fetch_content on the most relevant URL(s) afterwards.';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'network';

  constructor(private readonly deps: SearchWebToolDeps) {}

  async execute(args: SearchWebArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args.query !== 'string' || args.query.trim().length === 0) {
      return {
        ok: false,
        content: 'Error: query 不能为空',
        errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      };
    }

    const registry = this.deps.getRegistry();
    const candidates = pickProviders(args, registry);
    if (candidates.length === 0) {
      return {
        ok: false,
        content:
          'Error: 未配置任何可用的搜索引擎。请在 VSCode 设置 dualMind.webResearch.tavily.apiKeys 或 dualMind.webResearch.bocha.apiKeys。',
        errorCode: ErrorCodes.WEB_SEARCH_PROVIDER_DOWN,
      };
    }

    let last: SearchWebResult | undefined;
    for (const p of candidates.slice(0, 2)) {
      try {
        const r = await p.search(args, ctx.signal);
        last = r;
        if (r.results.length > 0) return formatSuccess(args, r);
      } catch {
        // swallow，继续尝试次选
      }
    }

    return {
      ok: false,
      content: `Error: 搜索失败（已尝试 ${candidates
        .slice(0, 2)
        .map((p) => p.id)
        .join(', ')}）。请检查 API Key 或稍后重试。`,
      errorCode: ErrorCodes.WEB_SEARCH_PROVIDER_DOWN,
      display: last ? { provider: last.provider, tookMs: last.tookMs } : undefined,
    };
  }
}

function formatSuccess(args: SearchWebArgs, r: SearchWebResult): ToolResult {
  const lines: string[] = [
    `Search results for "${args.query}" (provider=${r.provider}, ${r.tookMs}ms):`,
    '',
  ];
  r.results.forEach((item, i) => {
    lines.push(`${i + 1}. ${item.title}`);
    lines.push(`   URL: ${item.url}`);
    if (item.publishedAt) lines.push(`   Published: ${item.publishedAt}`);
    if (item.snippet) lines.push(`   ${item.snippet}`);
    lines.push('');
  });
  return {
    ok: true,
    content: lines.join('\n').trimEnd(),
    display: {
      provider: r.provider,
      tookMs: r.tookMs,
      results: r.results.map((x) => ({ title: x.title, url: x.url })),
    },
  };
}
