/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * search_memory 工具（W4 批次 2）
 *
 * 职责：以不同深度检索记忆
 *
 * 参数：
 * - depth: 'fetch' | 'shallow' | 'deep' | 'explore'
 * - query: 必填
 * - keywords: 可选（shallow/deep）
 * - category: 可选（shallow/deep 过滤）
 * - limit: 可选
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { MemoryStore, SearchDepth, MemoryRecord, MemoryHit } from '../memory/index.js';
import { searchMemories } from '../memory/search.js';
import type { Embedder } from '../index/embedder.js';
import { ErrorCodes, AgentError } from '../errors/index.js';

export interface SearchMemoryArgs {
  depth: SearchDepth;
  query: string;
  keywords?: string | string[];
  category?: string;
  limit?: number;
}

const parameters = {
  type: 'object',
  properties: {
    depth: {
      type: 'string',
      enum: ['fetch', 'shallow', 'deep', 'explore'],
      description:
        'fetch=按 title 精确命中；shallow=关键词快速搜索；deep=含模糊匹配；explore=按分类树探索（query 写路径，如 "user" / "user-user_info"）。',
    },
    query: {
      type: 'string',
      description:
        'fetch: 逗号分隔的 title 列表；shallow/deep: 自然语言；explore: 分类路径（如 "user" 或 "experience-expert_experience"）。',
    },
    keywords: {
      type: 'string',
      description: '逗号分隔的补充关键词（shallow/deep 才生效），最多 5 个。',
    },
    category: {
      type: 'string',
      description: '限定分类（shallow/deep 才生效）。',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: '最大返回数量。fetch 默认 5，shallow 10，deep 20，explore 30。',
    },
  },
  required: ['depth', 'query'],
  additionalProperties: false,
} as const;

export interface SearchMemoryDeps {
  getStore(): MemoryStore | undefined;
  /** v1.8.0：可选 embedder，用于向量检索增强 */
  getEmbedder?(): Embedder | undefined;
}

export class SearchMemoryTool implements ITool<SearchMemoryArgs, ToolResult> {
  readonly name = 'search_memory';
  readonly description =
    '检索记忆库。4 种深度：fetch（按标题精确）/ shallow（关键词）/ deep（含分类权重）/ explore（分类树导航）。explore 后通常再 fetch 具体标题。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: SearchMemoryDeps) {}

  async execute(args: SearchMemoryArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args.query !== 'string') {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'query 必填');
    }
    const store = this.deps.getStore();
    if (!store) {
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, '记忆存储未就绪');
    }
    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    try {
      const all = await store.list();
      const embedder = this.deps.getEmbedder?.();
      const out = await Promise.resolve(
        searchMemories(all, {
          depth: args.depth,
          query: args.query,
          keywords: normalizeKw(args.keywords),
          category: args.category,
          limit: args.limit,
        }, embedder),
      );
      if (out.kind === 'explore') {
        return formatExplore(out, args);
      }
      return formatHits(out.hits, args);
    } catch (e) {
      if (e instanceof AgentError) return fail(e.code, e.message);
      const err = e as { code?: string; message?: string };
      return fail(ErrorCodes.TOOL_EXEC_FAILED, err.message ?? String(e));
    }
  }
}

// ─────────── helpers ───────────

function formatHits(hits: MemoryHit[], args: SearchMemoryArgs): ToolResult {
  const head = `Memory search: depth=${args.depth} query="${args.query}"`;
  if (!hits.length) {
    return ok(`${head}\n0 results\n`, { depth: args.depth, count: 0 });
  }
  const parts: string[] = [head, `${hits.length} results:`];
  hits.forEach((h, i) => {
    parts.push(
      `## ${i + 1}. score=${h.score.toFixed(2)} [${h.record.category}] ${h.record.title} (id=${h.record.id}, scope=${h.record.scope})`,
    );
    parts.push(`matched: ${h.matchedOn.join(', ')}`);
    parts.push('```');
    parts.push(h.record.content);
    parts.push('```');
    parts.push('');
  });
  return ok(parts.join('\n'), {
    depth: args.depth,
    count: hits.length,
    hits: hits.map((h) => ({
      id: h.record.id,
      title: h.record.title,
      category: h.record.category,
      scope: h.record.scope,
      score: h.score,
    })),
  });
}

function formatExplore(
  out: { kind: 'explore'; groups: string[]; titles: Array<{ id: string; title: string; category: string }> },
  args: SearchMemoryArgs,
): ToolResult {
  const head = `Memory explore: path="${args.query}"`;
  const parts: string[] = [head];
  if (out.groups.length > 0) {
    parts.push('Subgroups:');
    out.groups.forEach((g) => parts.push(`- ${g}`));
  }
  if (out.titles.length > 0) {
    parts.push('Titles:');
    out.titles.forEach((t) => parts.push(`- [${t.category}] ${t.title} (id=${t.id})`));
  }
  if (out.groups.length === 0 && out.titles.length === 0) {
    parts.push('0 subgroups, 0 titles');
  }
  return ok(parts.join('\n') + '\n', {
    depth: 'explore',
    groups: out.groups,
    titles: out.titles,
  });
}

function normalizeKw(input: string | string[] | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  if (Array.isArray(input)) return input.map((s) => String(s));
  if (typeof input !== 'string') return undefined;
  return input.split(/[,，]+/).map((s) => s.trim()).filter(Boolean);
}

function ok(content: string, display?: Record<string, unknown>): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}) };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
