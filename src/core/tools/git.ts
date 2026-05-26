/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Git 只读工具（W11.8 · DESIGN §M9.8）
 *
 * 三个只读工具，统一依赖一个 `GitRunner`（默认用 `execFile('git', ...)`）：
 *
 * - `git_status`：`git status --porcelain=v1 -b` + 解析
 * - `git_diff`  ：`git diff`（可 `--cached` / 可带 pathspec）
 * - `git_log`   ：`git log -n <limit> --pretty=...`（可带 pathspec）
 *
 * 安全：
 * - 绝不执行任何"写"操作（commit / push / checkout / reset 一律不支持）
 * - pathspec 必须是 workspaceRoot 内的相对或绝对路径；拒绝 `..` 越界
 * - args 全部由本工具构造，**不拼接用户提供的原始字符串**到 shell；execFile 非 shell 模式
 * - 输出做 maxBuffer / maxLines 两级截断
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';

const execFile = promisify(execFileCb);

// ─────────── GitRunner 注入接口 ───────────

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type GitRunner = (
  args: readonly string[],
  opts: { cwd: string; signal: AbortSignal; timeoutMs?: number; maxBuffer?: number },
) => Promise<GitRunResult>;

/** 默认 runner：调用 `git` CLI */
export const defaultGitRunner: GitRunner = async (args, opts) => {
  try {
    const { stdout, stderr } = await execFile('git', args as string[], {
      cwd: opts.cwd,
      signal: opts.signal,
      timeout: opts.timeoutMs ?? 15_000,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    // execFile 失败时 err.code 可能是 number（退出码）或 string（'ENOENT'）
    if (typeof e.code === 'string') throw e;
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : String(e.message ?? e),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
};

// ─────────── 公共 deps / helpers ───────────

export interface GitToolsDeps {
  /** 注入点；默认使用 `git` CLI */
  runner?: GitRunner;
  /** 最大 stdout 截断字节；默认 4MB */
  maxBuffer?: number;
  /** 单次执行超时；默认 15s */
  timeoutMs?: number;
}

function requireCwd(ctx: ToolContext): string | null {
  return ctx.workspaceRoot ?? null;
}

/** 将用户传入的 path 归一化为 `相对 cwd 的相对路径`；越界返回 null */
function safePathspec(cwd: string, userPath: string): string | null {
  const p = userPath.trim();
  if (!p) return null;
  const abs = isAbsolute(p) ? resolvePath(p) : resolvePath(cwd, p);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  // 标准化为 posix 风格的 pathspec（git 在 Windows 也接受 '/'）
  return rel.split(/[\\/]+/).filter(Boolean).join('/');
}

function truncLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { text, truncated: false };
  return {
    text: lines.slice(0, maxLines).join('\n') + `\n… [truncated ${lines.length - maxLines} more line(s)]`,
    truncated: true,
  };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}

// ─────────── git_status ───────────

export interface GitStatusArgs {
  /** 保留参数，当前无使用 */
  _unused?: never;
}

export interface ParsedStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** XY 状态到文件的分组 */
  entries: Array<{ xy: string; path: string; orig?: string }>;
  clean: boolean;
}

/** 解析 `git status --porcelain=v1 -b` 输出 */
export function parseStatus(raw: string): ParsedStatus {
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const entries: ParsedStatus['entries'] = [];
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // e.g. "## main...origin/main [ahead 1, behind 2]" or "## HEAD (no branch)"
      const body = line.slice(3).trim();
      const bracket = body.match(/\[([^\]]+)\]\s*$/);
      const head = bracket ? body.slice(0, body.length - bracket[0].length).trim() : body;
      const parts = head.split('...');
      branch = parts[0] || null;
      upstream = parts[1] ?? null;
      if (bracket) {
        const a = bracket[1].match(/ahead (\d+)/);
        const b = bracket[1].match(/behind (\d+)/);
        ahead = a ? Number(a[1]) : 0;
        behind = b ? Number(b[1]) : 0;
      }
      continue;
    }
    // "XY path" / "XY orig -> path"
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    if (arrow >= 0) {
      entries.push({ xy, orig: rest.slice(0, arrow), path: rest.slice(arrow + 4) });
    } else {
      entries.push({ xy, path: rest });
    }
  }
  return { branch, upstream, ahead, behind, entries, clean: entries.length === 0 };
}

function formatStatus(s: ParsedStatus): string {
  const out: string[] = [];
  const br = s.branch ?? '(detached)';
  const up = s.upstream ? ` ↔ ${s.upstream}` : '';
  const ab: string[] = [];
  if (s.ahead) ab.push(`ahead ${s.ahead}`);
  if (s.behind) ab.push(`behind ${s.behind}`);
  out.push(`branch: ${br}${up}${ab.length ? ` [${ab.join(', ')}]` : ''}`);
  if (s.clean) {
    out.push('(clean)');
    return out.join('\n');
  }
  out.push(`changes: ${s.entries.length}`);
  for (const e of s.entries.slice(0, 200)) {
    if (e.orig) out.push(`  ${e.xy}  ${e.orig} -> ${e.path}`);
    else out.push(`  ${e.xy}  ${e.path}`);
  }
  if (s.entries.length > 200) out.push(`  … (${s.entries.length - 200} more)`);
  return out.join('\n');
}

export class GitStatusTool implements ITool<GitStatusArgs, ToolResult> {
  readonly name = 'git_status';
  readonly description =
    'Show working tree status (branch, ahead/behind, staged/unstaged changes). Read-only.';
  readonly parameters: Record<string, unknown> = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: GitToolsDeps = {}) {}

  async execute(_args: GitStatusArgs, ctx: ToolContext): Promise<ToolResult> {
    const cwd = requireCwd(ctx);
    if (!cwd) return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, '未打开工作区');
    const runner = this.deps.runner ?? defaultGitRunner;
    const res = await runner(['status', '--porcelain=v1', '-b'], {
      cwd,
      signal: ctx.signal,
      timeoutMs: this.deps.timeoutMs,
      maxBuffer: this.deps.maxBuffer,
    });
    if (res.code !== 0) {
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `git status 失败: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    const parsed = parseStatus(res.stdout);
    return {
      ok: true,
      content: formatStatus(parsed),
      display: parsed as unknown as Record<string, unknown>,
    };
  }
}

// ─────────── git_diff ───────────

export interface GitDiffArgs {
  /** 默认 false：工作区对 index 的差异；true 则显示 `--cached`（index 对 HEAD） */
  staged?: boolean;
  /** 可选 pathspec（文件或目录）；必须在 workspaceRoot 内 */
  path?: string;
  /** 最大行数，默认 500，上限 5000 */
  maxLines?: number;
}

export class GitDiffTool implements ITool<GitDiffArgs, ToolResult> {
  readonly name = 'git_diff';
  readonly description =
    'Show diff of working tree (default) or index (staged=true). Optional path pathspec restricted to workspace. Output capped by maxLines (default 500).';
  readonly parameters: Record<string, unknown> = {
    type: 'object',
    properties: {
      staged: { type: 'boolean', description: 'If true, show index vs HEAD (`git diff --cached`).' },
      path: { type: 'string', description: 'Optional file/dir pathspec (inside workspace).' },
      maxLines: { type: 'integer', minimum: 1, maximum: 5000 },
    },
    additionalProperties: false,
  };
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: GitToolsDeps = {}) {}

  async execute(args: GitDiffArgs, ctx: ToolContext): Promise<ToolResult> {
    const cwd = requireCwd(ctx);
    if (!cwd) return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, '未打开工作区');

    const gitArgs: string[] = ['diff', '--no-color'];
    if (args?.staged === true) gitArgs.push('--cached');

    if (args?.path != null && args.path !== '') {
      const rel = safePathspec(cwd, args.path);
      if (!rel) return fail(ErrorCodes.TOOL_ARGS_INVALID, `path 越界或非法: ${args.path}`);
      gitArgs.push('--', rel);
    }

    const runner = this.deps.runner ?? defaultGitRunner;
    const res = await runner(gitArgs, {
      cwd,
      signal: ctx.signal,
      timeoutMs: this.deps.timeoutMs,
      maxBuffer: this.deps.maxBuffer,
    });
    if (res.code !== 0) {
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `git diff 失败: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    const maxLines = clamp(args?.maxLines ?? 500, 1, 5000);
    const { text, truncated } = truncLines(res.stdout, maxLines);
    const content = text.length === 0 ? '(no changes)' : text;
    return {
      ok: true,
      content,
      display: { staged: args?.staged === true, path: args?.path ?? null, truncated },
    };
  }
}

// ─────────── git_log ───────────

export interface GitLogArgs {
  /** 默认 20，上限 200 */
  limit?: number;
  /** 可选 pathspec，限制在 workspace 内 */
  path?: string;
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

const LOG_FORMAT = '%H%x1f%an%x1f%ad%x1f%s';

export function parseLog(raw: string): GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const parts = line.split('\x1f');
    if (parts.length < 4) continue;
    entries.push({ hash: parts[0], author: parts[1], date: parts[2], subject: parts.slice(3).join('\x1f') });
  }
  return entries;
}

function formatLog(entries: GitLogEntry[]): string {
  if (entries.length === 0) return '(no commits)';
  return entries
    .map((e) => `${e.hash.slice(0, 8)}  ${e.date}  ${e.author}\n    ${e.subject}`)
    .join('\n');
}

export class GitLogTool implements ITool<GitLogArgs, ToolResult> {
  readonly name = 'git_log';
  readonly description =
    'List recent commits (hash/author/date/subject). limit default 20, max 200. Optional path pathspec inside workspace.';
  readonly parameters: Record<string, unknown> = {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      path: { type: 'string', description: 'Optional file/dir pathspec (inside workspace).' },
    },
    additionalProperties: false,
  };
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: GitToolsDeps = {}) {}

  async execute(args: GitLogArgs, ctx: ToolContext): Promise<ToolResult> {
    const cwd = requireCwd(ctx);
    if (!cwd) return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, '未打开工作区');

    const limit = clamp(args?.limit ?? 20, 1, 200);
    const gitArgs: string[] = [
      'log',
      `-n`, String(limit),
      '--no-color',
      '--date=iso-strict',
      `--pretty=format:${LOG_FORMAT}`,
    ];

    if (args?.path != null && args.path !== '') {
      const rel = safePathspec(cwd, args.path);
      if (!rel) return fail(ErrorCodes.TOOL_ARGS_INVALID, `path 越界或非法: ${args.path}`);
      gitArgs.push('--', rel);
    }

    const runner = this.deps.runner ?? defaultGitRunner;
    const res = await runner(gitArgs, {
      cwd,
      signal: ctx.signal,
      timeoutMs: this.deps.timeoutMs,
      maxBuffer: this.deps.maxBuffer,
    });
    if (res.code !== 0) {
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `git log 失败: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    const entries = parseLog(res.stdout);
    return {
      ok: true,
      content: formatLog(entries),
      display: { entries, limit, path: args?.path ?? null },
    };
  }
}

// ─────────── utils ───────────

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
