/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * search_codebase 工具（W3 批次 1）
 *
 * 职责：基于 CodebaseIndex 做自然语言→代码片段检索
 *
 * 参数：
 * - query: 自然语言 / 代码关键词
 * - top_k: 返回数量（默认 10，最大 30）
 *
 * 输出格式（给 LLM）：
 *   Query: "<query>"
 *   Results: N matches
 *   ## 1. <score> [<file>:<startLine>-<endLine>]
 *   ```
 *   <chunk text>
 *   ```
 *   ## 2. ...
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { IndexReader, SearchResult } from '../index/codebase-index.js';
import { ErrorCodes } from '../errors/index.js';
import { collectEnvironment } from '../prompts/environment-probe.js';
import { detectShellKind, renderFallbackBlock, type ShellKind } from './shell-hint.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface SearchCodebaseArgs {
  query: string;
  top_k?: number;
}

const parameters = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '自然语言或代码关键词。示例："处理 OpenAI 流式响应" / "JWT 签名校验"。',
    },
    top_k: {
      type: 'integer',
      minimum: 1,
      maximum: 30,
      description: '返回结果数量，默认 10，最大 30。',
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

/** 工厂：因为索引实例在运行时才有，工具需要通过闭包注入 */
export interface SearchCodebaseDeps {
  /**
   * 返回当前激活索引；未就绪时返回 undefined。
   * W13.4-C-1：类型从 `CodebaseIndex` 拓宽到 `IndexReader`，以支持 BM25 保底路径。
   */
  getIndex(): IndexReader | undefined;
  /**
   * W13.1-B · 可选注入 shell 探测结果；未传则走 `collectEnvironment()` 默认。
   * 单测可直接注入，避免依赖 process / SHELL 环境变量。
   */
  getShellKind?(): ShellKind;
}

export class SearchCodebaseTool implements ITool<SearchCodebaseArgs, ToolResult> {
  readonly name = 'search_codebase';
  readonly description =
    '在已建立的代码库语义索引中做自然语言搜索，返回 top-K 相关代码片段（含文件路径与行号）。适合首次进入不熟悉代码库时定位相关实现。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: SearchCodebaseDeps) {}

  async execute(args: SearchCodebaseArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args.query !== 'string' || !args.query.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'query 不能为空');
    }
    const topK = Math.min(30, Math.max(1, args.top_k ?? 10));

    const index = this.deps.getIndex();
    if (!index) {
      // B-1.0.1-B · 软降级：索引未就绪时不 hard fail，引导 Agent 走 fallback
      return softIndexNotReady(args.query, 'missing', this.resolveShellKind());
    }

    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    try {
      const rawHits = await index.search(args.query, topK);
      if (!rawHits.length) {
        return ok(`Query: "${args.query}"\nResults: 0 matches\n`, {
          query: args.query,
          count: 0,
        });
      }

      // 从磁盘读取原文填充 text（索引库不再存储 text 文本）
      const workspaceRoot = ctx.workspaceRoot;
      const hits: Array<SearchResult & { text: string }> = await Promise.all(
        rawHits.map(async (h) => {
          let text: string;
          if (workspaceRoot) {
            text = await readFileLines(join(workspaceRoot, h.filePath), h.startLine, h.endLine);
          } else {
            text = `[file not accessible: no workspace root]`;
          }
          return { ...h, text };
        }),
      );

      const parts: string[] = [];
      parts.push(`Query: "${args.query}"`);
      parts.push(`Results: ${hits.length} matches`);
      parts.push('');
      hits.forEach((h, i) => {
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
        hits: hits.map((h) => ({
          filePath: h.filePath,
          startLine: h.startLine,
          endLine: h.endLine,
          score: h.score,
        })),
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === ErrorCodes.INDEX_NOT_READY) {
        // B-1.0.1-B · store 空库或加载失败同样软降级
        return softIndexNotReady(args.query, 'empty', this.resolveShellKind());
      }
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `搜索失败：${err.message ?? String(e)}`);
    }
  }

  /** 优先使用注入的 kind；未注入时现场探测环境 */
  private resolveShellKind(): ShellKind {
    if (this.deps.getShellKind) return this.deps.getShellKind();
    const env = collectEnvironment();
    return detectShellKind({ platform: env.platform, shell: env.shell });
  }
}

// ─────────── helpers ───────────

/**
 * B-1.0.1-B · 索引未就绪的软降级返回。
 *
 * 关键点：
 *  - `ok: true`（工具卡不再标红）
 *  - content 按 prompt-friendly 格式给出 fallback 建议（DualMind 工具单：list_dir / read_file / lsp workspace_symbol / bash rg）
 *  - display.indexState 标记 'not_ready'，供 UI 改蓝色 info 样式、供 Agent 推理判断
 *
 * W13.1-B · 升级：接受 `shellKind` 参数，按平台注入可复制的 bash 命令模板
 * （PowerShell `Select-String` / cmd `findstr` / bash `grep -rn` / zsh 同 bash）
 * 消除 Phase B 观察到的 Agent 命令试错问题。
 */
function softIndexNotReady(
  query: string,
  reason: 'missing' | 'empty',
  shellKind: ShellKind,
): ToolResult {
  const reasonText =
    reason === 'missing'
      ? '代码库语义索引未初始化或已过期。'
      : '代码库语义索引仍为空（可能第一次打开或建索引未完成）。';

  const fallbackLines = renderFallbackBlock({ kind: shellKind, exampleKeyword: query });

  const lines: string[] = [
    `Query: "${query}"`,
    `Results: 0 matches (index not ready)`,
    '',
    reasonText,
    '',
    ...fallbackLines,
    '',
    '后台索引将在打开工作区后自动尝试建立；如需立刻重建可运行命令 `DualMind: Reindex Codebase`。',
  ];

  return {
    ok: true,
    content: lines.join('\n'),
    display: {
      query,
      count: 0,
      indexState: 'not_ready',
      reason,
      soft: true,
      shellKind,
      suggestedFallbacks: ['list_dir', 'read_file', 'lsp.workspace_symbol', 'bash_rg'],
    },
  };
}

// ─────────── helpers ───────────

function ok(content: string, display?: Record<string, unknown>): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}) };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}

// ─────────── 从磁盘读取文件行 ───────────

/**
 * 读取文件指定行范围的内容（1-based，闭区间）。
 * 文件不存在或读取失败时返回友好 fallback 文本。
 */
async function readFileLines(filePath: string, startLine: number, endLine: number): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    if (startLine < 1 || startLine > lines.length) {
      return `[invalid line range: ${startLine}-${endLine}, file has ${lines.length} lines]`;
    }
    const selected = lines.slice(startLine - 1, endLine);
    return selected.join('\n');
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return `[file deleted: ${filePath}]`;
    }
    return `[error reading ${filePath}: ${err.message}]`;
  }
}
