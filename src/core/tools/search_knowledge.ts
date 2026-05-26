/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W14.2 · search_knowledge 工具
 *
 * 职责：在用户私有知识库（`.dualmind/knowledge/**\/*.md`）内做自然语言检索
 *   - 与 `search_codebase` 分库，独立 BM25 索引
 *   - 只读：ToolSafetyLevel = 'read_only'
 *   - 懒加载：panel 通过闭包 getIndex() 返回当前 KnowledgeReader
 *
 * 软降级：
 *   - 目录不存在（KNOWLEDGE_BASE_EMPTY）→ ok:true + 引导文案（让 Agent 明确建议用户创建）
 *   - 索引未就绪（INDEX_NOT_READY / size=0）→ ok:true + 请用户运行 reindex
 *
 * 输出格式与 search_codebase 对齐，便于 LLM 复用已习得的"匹配片段"模板。
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { IndexReader, SearchResult } from '../index/codebase-index.js';
import { ErrorCodes } from '../errors/index.js';

export interface SearchKnowledgeArgs {
  query: string;
  top_k?: number;
}

const parameters = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        '自然语言或关键词。示例："项目交付流程" / "on-call 轮值规则" / "API 签名规范"。',
    },
    top_k: {
      type: 'integer',
      minimum: 1,
      maximum: 30,
      description: '返回结果数量，默认 8，最大 30。',
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

/**
 * 依赖注入：panel 通过闭包提供当前知识库索引（懒加载）。
 *
 * `getIndex` 的返回值语义：
 *   - Promise<IndexReader> 成功：已就绪的知识库索引
 *   - Promise reject 且 code === KNOWLEDGE_BASE_EMPTY：知识库目录缺失（软降级）
 *   - Promise reject 其它：hard fail（工具卡标红）
 */
export interface SearchKnowledgeDeps {
  getIndex(): Promise<IndexReader>;
}

export class SearchKnowledgeTool implements ITool<SearchKnowledgeArgs, ToolResult> {
  readonly name = 'search_knowledge';
  readonly description =
    '在用户私有知识库（.dualmind/knowledge/**/*.md）中做自然语言检索，返回 top-K 相关文档片段。适合查询团队规范、架构说明、onboarding 等业务知识。与 search_codebase 分库，仅命中用户明确维护的 markdown 文档。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: SearchKnowledgeDeps) {}

  async execute(args: SearchKnowledgeArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args.query !== 'string' || !args.query.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'query 不能为空');
    }
    const topK = Math.min(30, Math.max(1, args.top_k ?? 8));

    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    let index: IndexReader;
    try {
      index = await this.deps.getIndex();
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === ErrorCodes.KNOWLEDGE_BASE_EMPTY) {
        return softKbMissing(args.query, err.message);
      }
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `知识库加载失败：${err.message ?? String(e)}`);
    }

    if (index.size() === 0) {
      return softKbNotReady(args.query);
    }

    try {
      const hits = await index.search(args.query, topK);
      if (!hits.length) {
        return ok(`Query: "${args.query}"\nResults: 0 matches\n`, {
          query: args.query,
          count: 0,
          source: 'knowledge',
        });
      }

      const parts: string[] = [];
      parts.push(`Query: "${args.query}"`);
      parts.push(`Results: ${hits.length} matches (source=knowledge)`);
      parts.push('');
      hits.forEach((h: SearchResult, i: number) => {
        parts.push(
          `## ${i + 1}. score=${h.score.toFixed(3)} [${h.filePath}:${h.startLine}-${h.endLine}]`,
        );
        parts.push('```');
        parts.push(h.text);
        parts.push('```');
        parts.push('');
      });

      return ok(parts.join('\n'), {
        query: args.query,
        count: hits.length,
        source: 'knowledge',
        hits: hits.map((h: SearchResult) => ({
          filePath: h.filePath,
          startLine: h.startLine,
          endLine: h.endLine,
          score: h.score,
        })),
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === ErrorCodes.INDEX_NOT_READY) return softKbNotReady(args.query);
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `知识库搜索失败：${err.message ?? String(e)}`);
    }
  }
}

// ─────────── helpers ───────────

function ok(content: string, display?: Record<string, unknown>): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}) };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}

function softKbMissing(query: string, detail?: string): ToolResult {
  const lines = [
    `Query: "${query}"`,
    `Results: 0 matches (knowledge base not initialized)`,
    '',
    detail ??
      '知识库目录不存在。请创建 `.dualmind/knowledge/` 并放入 `.md` 文档（团队规范 / 架构说明 / onboarding 等），再运行 `DualMind: Reindex Knowledge` 建索引。',
    '',
    '如需查询代码库，请改用 `search_codebase` 工具。',
  ];
  return {
    ok: true,
    content: lines.join('\n'),
    display: {
      query,
      count: 0,
      source: 'knowledge',
      indexState: 'not_initialized',
      soft: true,
    },
  };
}

function softKbNotReady(query: string): ToolResult {
  const lines = [
    `Query: "${query}"`,
    `Results: 0 matches (knowledge base empty / not indexed)`,
    '',
    '知识库尚未建立索引或无可索引的 markdown 文件。请先运行命令 `DualMind: Reindex Knowledge`，或确认 `.dualmind/knowledge/` 内确有 `.md` 文档。',
  ];
  return {
    ok: true,
    content: lines.join('\n'),
    display: {
      query,
      count: 0,
      source: 'knowledge',
      indexState: 'not_ready',
      soft: true,
    },
  };
}
