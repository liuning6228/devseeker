/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * get_repo_map 工具（Repo Map 优化方案 T2）
 *
 * 职责：从 P2 图索引渲染代码骨架地图（文件 → 关键符号，按被调用热度排序），
 * 让 LLM 不读全量源码即可理解程序主干；focus 支持定向下钻。
 *
 * 参数：
 * - focus: 可选。目录/文件路径前缀（如 "src/core/"）→ 展开该范围符号；
 *          符号名（如 "buildRepoMap"）→ 展开 ±1 跳调用邻接骨架。
 * - max_tokens: 输出 token 预算（默认 1500，clamp [500, 4000]）。
 *
 * 降级（对齐 search_codebase 的软失败语义）：
 * - 图索引未初始化/空 → ok:true + 替代方案引导，不 hard fail。
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { RepoMapGraphSource } from '../index/repo-map.js';
import { buildRepoMap } from '../index/repo-map.js';
import { ErrorCodes } from '../errors/index.js';

export interface GetRepoMapArgs {
  focus?: string;
  max_tokens?: number;
}

export interface GetRepoMapDeps {
  /** 懒获取图索引（与 search_codebase 同款闭包注入）；未就绪返回 undefined */
  getGraphIndex(): Promise<RepoMapGraphSource | undefined>;
}

const parameters = {
  type: 'object',
  properties: {
    focus: {
      type: 'string',
      description:
        '可选。定向展开局部骨架：传目录/文件路径（完整相对路径如 "src/core/"、"src/webview/panel.ts"，也支持裸文件名 "panel.ts" 或裸目录名 "core"，按路径段匹配）返回该范围的符号列表；传符号名（如 "buildSystemPrompt"）返回 ±1 跳调用邻接骨架。缺省输出全局代码骨架。',
    },
    max_tokens: {
      type: 'integer',
      minimum: 500,
      maximum: 4000,
      description: '输出 token 预算上限，默认 1500。',
    },
  },
  additionalProperties: false,
} as const;

export class GetRepoMapTool implements ITool<GetRepoMapArgs, ToolResult> {
  readonly name = 'get_repo_map';
  readonly description =
    '获取代码库骨架地图（文件 → 关键符号，按被调用热度排序）。适合首次进入不熟悉代码库、需要快速理解整体程序结构时使用。focus 可定向展开：传目录/文件路径看该范围符号，传符号名看 ±1 跳调用关系。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: GetRepoMapDeps) {}

  async execute(args: GetRepoMapArgs, ctx: ToolContext): Promise<ToolResult> {
    const focus = typeof args?.focus === 'string' ? args.focus.trim() : '';
    const maxTokens = clampInt(args?.max_tokens, 500, 4000, 1500);

    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    let graph: RepoMapGraphSource | undefined;
    try {
      graph = await this.deps.getGraphIndex();
    } catch {
      graph = undefined;
    }

    if (!graph || graph.size() === 0) {
      return softIndexNotReady(focus);
    }

    const result = buildRepoMap(graph, {
      maxTokens,
      ...(focus ? { focus } : {}),
    });

    if (!result.text) {
      // 图就绪但无命中（focus 未匹配 / 热榜为空）
      const hint = focus
        ? `未在代码骨架中匹配到 "${focus}"。可尝试更短的路径前缀（如 "src/core/"），或用 search_codebase / lsp.workspace_symbol 先定位符号名。`
        : '代码骨架暂无数据（图索引可能正在后台构建中）。稍后重试，或先用 list_dir / read_file 探索。';
      return {
        ok: true,
        content: hint,
        display: {
          ...(focus ? { focus } : {}),
          empty: true,
          ...result.stats,
        },
      };
    }

    return {
      ok: true,
      content: result.text,
      display: {
        ...(focus ? { focus } : {}),
        files: result.stats.files,
        symbols: result.stats.symbols,
        truncated: result.stats.truncated,
      },
    };
  }
}

// ─────────── helpers ───────────

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return dflt;
  return Math.min(max, Math.max(min, v));
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}

/** 图索引未就绪 → 软降级：引导 LLM 走既有 fallback 工具（不 hard fail） */
function softIndexNotReady(focus: string): ToolResult {
  const lines: string[] = [
    '代码骨架不可用：图索引尚未初始化或仍为空（后台可能正在构建）。',
    '',
    '替代方案：',
    '- `list_dir` 查看目录结构',
    '- `search_codebase` 语义检索定位相关实现',
    '- `lsp.workspace_symbol` 按符号名查找',
    '- `read_file` 直接读取关键文件',
    '',
    '后台索引将在打开工作区后自动尝试建立；稍后重试 `get_repo_map`。',
  ];
  return {
    ok: true,
    content: lines.join('\n'),
    display: {
      ...(focus ? { focus } : {}),
      indexState: 'not_ready',
      soft: true,
      suggestedFallbacks: ['list_dir', 'search_codebase', 'lsp.workspace_symbol', 'read_file'],
    },
  };
}
