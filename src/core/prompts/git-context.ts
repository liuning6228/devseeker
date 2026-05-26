/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * GitContextProbe（B-P1-11 · DESIGN §M3.6 · W5.15）
 *
 * 在 buildSystemPrompt 时**自动**采集 Git 上下文，输出一个 `<git_context>...</git_context>`
 * 块注入到 L3 附件层。与 `git_status / git_diff / git_log` 工具 **互不冲突**：
 *   - 工具：LLM 显式调用、返回到消息正文
 *   - 本模块：每轮 System Prompt 静默附带
 *
 * 采集内容（顺序稳定）：
 *   1. current branch + upstream + ahead/behind（从 `git status --porcelain=v1 -b` 第一行）
 *   2. 最近 N 条 commits（`git log -n N --pretty=format:"%h %s"`）
 *   3. staged diff stat（`git diff --cached --stat`，N 行截断）
 *   4. working-dir short status（仅列出文件名，N 行截断）
 *
 * 非 git 仓库 / git 未安装 / cwd 无效 → 返回 `undefined`（prompt 不注入）。
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// 与 tools/git.ts 的 GitRunner 保持兼容，便于单测注入
export interface GitCtxRunResult {
  stdout: string;
  stderr: string;
  code: number;
}
export type GitCtxRunner = (
  args: readonly string[],
  opts: { cwd: string; timeoutMs?: number; maxBuffer?: number },
) => Promise<GitCtxRunResult>;

export const defaultGitCtxRunner: GitCtxRunner = async (args, opts) => {
  try {
    const { stdout, stderr } = await execFile('git', args as string[], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 3000,
      maxBuffer: opts.maxBuffer ?? 256 * 1024,
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
    if (typeof e.code === 'string') {
      // ENOENT（git 未装）/ abort 等 → 交给上层视为"采集失败"
      return { stdout: '', stderr: String(e.message ?? e), code: -1 };
    }
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : String(e.message ?? e),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
};

export interface CollectGitContextOptions {
  /** 仓库根；通常 = workspaceRoot */
  cwd: string;
  /** 注入点；默认调用 `git` CLI */
  runner?: GitCtxRunner;
  /** log 展示的最近 commits 数；默认 5 */
  maxCommits?: number;
  /** staged diff stat / status 的行截断；默认 20 */
  maxDiffLines?: number;
  /** 单次 exec 超时；默认 3s（避免阻塞 buildSystemPrompt） */
  timeoutMs?: number;
}

export interface GitContextSnapshot {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  recentCommits: string[];
  stagedStat: string;
  stagedFileCount: number;
  statusShort: string;
}

function truncLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length <= maxLines) return lines.join('\n');
  return (
    lines.slice(0, maxLines).join('\n') +
    `\n… [truncated ${lines.length - maxLines} more line(s)]`
  );
}

/**
 * 采集 Git 上下文快照。不抛错：任何子命令失败都容忍为缺省值，
 * 最终由 `formatGitContext` 判断是否值得输出块头。
 *
 * 非 git 仓库 / git 未装 → status 取不到 → 返回 undefined。
 */
export async function collectGitContext(
  opts: CollectGitContextOptions,
): Promise<GitContextSnapshot | undefined> {
  const runner = opts.runner ?? defaultGitCtxRunner;
  const maxCommits = opts.maxCommits ?? 5;
  const maxDiffLines = opts.maxDiffLines ?? 20;
  const timeoutMs = opts.timeoutMs ?? 3000;

  // 1) status -b --short —— 同时做"是否 git 仓库"的存活性探针
  const statusRes = await runner(['status', '--porcelain=v1', '-b'], {
    cwd: opts.cwd,
    timeoutMs,
  });
  if (statusRes.code !== 0) return undefined;

  const statusLines = statusRes.stdout.split(/\r?\n/).filter((l) => l.length > 0);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const workingLines: string[] = [];
  for (const line of statusLines) {
    if (line.startsWith('## ')) {
      const body = line.slice(3).trim();
      const bracket = body.match(/\[([^\]]+)\]\s*$/);
      const head = bracket ? body.slice(0, body.length - bracket[0].length).trim() : body;
      const parts = head.split('...');
      branch = parts[0] || null;
      upstream = parts[1] ?? null;
      if (bracket && bracket[1]) {
        const m1 = bracket[1].match(/ahead\s+(\d+)/);
        const m2 = bracket[1].match(/behind\s+(\d+)/);
        if (m1 && m1[1]) ahead = parseInt(m1[1], 10);
        if (m2 && m2[1]) behind = parseInt(m2[1], 10);
      }
    } else {
      workingLines.push(line);
    }
  }

  // 2) 最近 N 条 commits
  const logRes = await runner(
    ['log', `-n`, String(maxCommits), '--pretty=format:%h %s'],
    { cwd: opts.cwd, timeoutMs },
  );
  const recentCommits =
    logRes.code === 0
      ? logRes.stdout.split(/\r?\n/).filter((l) => l.length > 0)
      : [];

  // 3) staged diff stat
  const stagedRes = await runner(['diff', '--cached', '--stat'], {
    cwd: opts.cwd,
    timeoutMs,
  });
  const stagedStat = stagedRes.code === 0 ? truncLines(stagedRes.stdout, maxDiffLines) : '';
  const stagedFileCount =
    stagedRes.code === 0
      ? stagedRes.stdout
          .split(/\r?\n/)
          .filter((l) => /^\s\S.*\|\s/.test(l)).length
      : 0;

  // 4) short working status (files only)
  const statusShort = truncLines(workingLines.join('\n'), maxDiffLines);

  return {
    branch,
    upstream,
    ahead,
    behind,
    recentCommits,
    stagedStat,
    stagedFileCount,
    statusShort,
  };
}

/**
 * 格式化快照为 `<git_context>...</git_context>` 块。
 * 所有字段都为空时返回空串（由调用方决定是否注入）。
 */
export function formatGitContext(snap: GitContextSnapshot): string {
  const parts: string[] = [];
  if (snap.branch) {
    const upstream = snap.upstream ? ` ⇄ ${snap.upstream}` : '';
    const lag =
      snap.ahead || snap.behind ? ` [ahead ${snap.ahead}, behind ${snap.behind}]` : '';
    parts.push(`branch: ${snap.branch}${upstream}${lag}`);
  }
  if (snap.recentCommits.length > 0) {
    parts.push('recent_commits:');
    for (const c of snap.recentCommits) parts.push(`  ${c}`);
  }
  if (snap.stagedFileCount > 0 && snap.stagedStat) {
    parts.push(`staged (${snap.stagedFileCount} file(s)):`);
    parts.push(snap.stagedStat);
  }
  if (snap.statusShort) {
    parts.push('status:');
    parts.push(snap.statusShort);
  }
  if (parts.length === 0) return '';
  return ['<git_context>', ...parts, '</git_context>'].join('\n');
}

/** 一步到位：采集并格式化，失败/空仓库返回 undefined */
export async function buildGitContextBlock(
  opts: CollectGitContextOptions,
): Promise<string | undefined> {
  const snap = await collectGitContext(opts);
  if (!snap) return undefined;
  const body = formatGitContext(snap);
  return body.length > 0 ? body : undefined;
}
