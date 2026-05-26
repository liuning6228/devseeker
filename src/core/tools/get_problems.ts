/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * get_problems 工具（W7e1 · 原 W11.6 前移）
 *
 * 职责：读取 VSCode Problems 面板的诊断列表（TS / ESLint / Biome / 其它 LSP），
 * 帮助 Agent 在 T3 Debug 场景里定位语法/类型错误。
 *
 * 参数：
 * - file_paths?: string[] — 可选限定文件（相对工作区或绝对）；不传则全工作区
 * - min_severity?: 'error' | 'warning' | 'info' | 'hint' — 可选最低严重级（含），默认 'hint'
 * - limit?: number — 可选条数上限，默认 200，最大 1000
 *
 * 输出：
 *   Problems (N total, showing M):
 *   1. [error] src/a.ts:10:5 — Cannot find name 'foo'. (ts 2304)
 *   2. [warning] src/b.ts:3:1 — 'bar' is defined but never used. (eslint no-unused-vars)
 *   ...
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type {
  DiagnosticItem,
  DiagnosticSeverity,
  ProblemsBridge,
} from '../problems/index.js';
import { SEVERITY_ORDER } from '../problems/index.js';
import { ErrorCodes, AgentError } from '../errors/index.js';

export interface GetProblemsArgs {
  file_paths?: string[];
  min_severity?: DiagnosticSeverity;
  limit?: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

const parameters = {
  type: 'object',
  properties: {
    file_paths: {
      type: 'array',
      items: { type: 'string' },
      description:
        '可选：限定这些文件的诊断（相对工作区或绝对路径）。不传则返回整个工作区的诊断。',
    },
    min_severity: {
      type: 'string',
      enum: ['error', 'warning', 'info', 'hint'],
      description: '可选：最低严重级（含）。默认 "hint"（返回全部）。',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `可选：最多返回多少条，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}。`,
    },
  },
  additionalProperties: false,
} as const;

export interface GetProblemsDeps {
  /** 懒获取桥接器；未就绪（非 VSCode 宿主）返回 undefined */
  getBridge(): ProblemsBridge | undefined;
}

export class GetProblemsTool implements ITool<GetProblemsArgs, ToolResult> {
  readonly name = 'get_problems';
  readonly description =
    '读取 VSCode Problems 面板的诊断列表（TS/ESLint/Biome/其它 LSP 的错误与警告）。可按文件或严重级过滤。典型用于 Debug 时快速定位编译/类型问题。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: GetProblemsDeps) {}

  async execute(args: GetProblemsArgs, ctx: ToolContext): Promise<ToolResult> {
    const validationErr = validateArgs(args);
    if (validationErr) return fail(ErrorCodes.TOOL_ARGS_INVALID, validationErr);

    const bridge = this.deps.getBridge();
    if (!bridge) {
      return fail(
        ErrorCodes.LSP_SERVER_NOT_RUNNING,
        '诊断提供者未就绪（需运行在 VSCode 扩展宿主内，或未打开工作区）',
      );
    }
    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    try {
      const opts: Parameters<ProblemsBridge['getDiagnostics']>[0] = {};
      if (args?.file_paths && args.file_paths.length > 0) opts.filePaths = args.file_paths;
      if (args?.min_severity) opts.minSeverity = args.min_severity;
      const all = await bridge.getDiagnostics(opts);
      const limit = Math.min(MAX_LIMIT, Math.max(1, args?.limit ?? DEFAULT_LIMIT));
      return formatProblems(all, limit, args);
    } catch (e) {
      return handleError(e);
    }
  }
}

// ─────────── helpers ───────────

export function validateArgs(args: GetProblemsArgs | undefined): string | undefined {
  if (!args) return undefined;
  if (args.file_paths !== undefined) {
    if (!Array.isArray(args.file_paths)) return 'file_paths 必须是字符串数组';
    for (const fp of args.file_paths) {
      if (typeof fp !== 'string' || !fp.trim()) return 'file_paths 元素必须是非空字符串';
    }
  }
  if (args.min_severity !== undefined) {
    if (!['error', 'warning', 'info', 'hint'].includes(args.min_severity)) {
      return `min_severity 必须是 'error' | 'warning' | 'info' | 'hint' 之一`;
    }
  }
  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIMIT) {
      return `limit 必须是 1..${MAX_LIMIT} 的整数`;
    }
  }
  return undefined;
}

export function formatProblems(
  all: DiagnosticItem[],
  limit: number,
  args: GetProblemsArgs | undefined,
): ToolResult {
  const total = all.length;
  const shown = all.slice(0, limit);
  const scope =
    args?.file_paths && args.file_paths.length > 0
      ? ` in ${args.file_paths.length} file(s)`
      : '';
  const sevFilter = args?.min_severity ? ` (min: ${args.min_severity})` : '';

  if (total === 0) {
    return ok(`Problems${scope}${sevFilter}: 0 total\n`, {
      total: 0,
      counts: { error: 0, warning: 0, info: 0, hint: 0 },
      problems: [],
    });
  }

  const counts = countBySeverity(all);
  const head =
    total === shown.length
      ? `Problems${scope}${sevFilter} (${total} total — err:${counts.error} warn:${counts.warning} info:${counts.info} hint:${counts.hint}):`
      : `Problems${scope}${sevFilter} (${total} total, showing ${shown.length} — err:${counts.error} warn:${counts.warning} info:${counts.info} hint:${counts.hint}):`;
  const lines: string[] = [head];
  shown.forEach((d, i) => {
    const tag = `[${d.severity}]`;
    const loc = `${d.filePath}:${d.line}:${d.character}`;
    const src = formatSource(d);
    const msg = d.message.replace(/\s+/g, ' ').trim();
    lines.push(`${i + 1}. ${tag} ${loc} — ${msg}${src}`);
  });
  if (total > shown.length) {
    lines.push(
      `… ${total - shown.length} more omitted (increase "limit" to see more; sorted by severity)`,
    );
  }
  return ok(lines.join('\n') + '\n', {
    total,
    counts,
    problems: shown,
  });
}

function countBySeverity(
  list: DiagnosticItem[],
): Record<DiagnosticSeverity, number> {
  const c: Record<DiagnosticSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
    hint: 0,
  };
  for (const d of list) c[d.severity]++;
  // 使用 SEVERITY_ORDER 仅为保持顺序一致性（引用以避免 tree-shaking 丢掉 import）
  void SEVERITY_ORDER;
  return c;
}

function formatSource(d: DiagnosticItem): string {
  const parts: string[] = [];
  if (d.source) parts.push(d.source);
  if (d.code !== undefined) parts.push(String(d.code));
  return parts.length ? ` (${parts.join(' ')})` : '';
}

export function handleError(e: unknown): ToolResult {
  if (e instanceof AgentError) {
    return fail(e.code, e.message);
  }
  const err = e as { code?: string; message?: string };
  return fail(ErrorCodes.TOOL_EXEC_FAILED, `诊断读取失败：${err.message ?? String(e)}`);
}

function ok(content: string, display?: Record<string, unknown>): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}) };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
