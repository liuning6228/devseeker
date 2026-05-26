/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C5 · Git 面板 UI（B-P1-4）
 *
 * 展示（只读）：
 *   - branch + upstream + ahead/behind
 *   - status 分组：staged / modified / untracked / conflicts
 *   - 最近 N 条 commits（log）
 *   - 当前选中文件 diff（工作区 vs HEAD 或 staged）
 *
 * 复用 `src/core/tools/git.ts` 的 defaultGitRunner / parseStatus / parseLog，
 * 不新增 git 执行路径；面板不修改仓库（非破坏性动作）。
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  defaultGitRunner,
  parseStatus,
  parseLog,
  type GitRunner,
  type ParsedStatus,
  type GitLogEntry,
} from '../../core/tools/git.js';
import {
  renderBaseHtml,
  genPanelNonce,
  escapeHtml,
} from './base.js';

// ─────────── 数据层 ───────────

export interface GitPanelStatusGroup {
  label: string;
  kind: 'staged' | 'modified' | 'untracked' | 'conflict';
  entries: Array<{ xy: string; path: string; orig?: string }>;
}

export interface GitPanelInput {
  workspaceRoot: string | undefined;
  isRepo: boolean;
  /** 仓库访问失败时的错误提示（用于 banner 展示） */
  error: string | undefined;
  status: ParsedStatus | undefined;
  statusGroups: GitPanelStatusGroup[];
  log: GitLogEntry[];
  /** 当前选中文件 diff（可选：未选中时 undefined） */
  selectedPath: string | undefined;
  selectedStaged: boolean;
  diff: { text: string; truncated: boolean } | undefined;
  generatedAt: string;
}

export interface CollectGitPanelOpts {
  workspaceRoot: string | undefined;
  /** 可选：指定 log 行数，默认 20，clamp 1..200 */
  logLimit?: number;
  /** 可选：指定 diff 行数，默认 500，clamp 1..5000 */
  diffMaxLines?: number;
  /** 可选：选中的文件（相对 workspaceRoot） */
  selectedPath?: string;
  /** 默认 false（显示工作区 vs HEAD 的 diff） */
  selectedStaged?: boolean;
  /** 可替换的 runner（测试用） */
  runner?: GitRunner;
  signal?: AbortSignal;
}

export async function collectGitPanelInput(opts: CollectGitPanelOpts): Promise<GitPanelInput> {
  const now = new Date().toISOString();
  if (!opts.workspaceRoot) {
    return {
      workspaceRoot: undefined,
      isRepo: false,
      error: 'No workspace folder open.',
      status: undefined,
      statusGroups: [],
      log: [],
      selectedPath: undefined,
      selectedStaged: false,
      diff: undefined,
      generatedAt: now,
    };
  }
  const runner = opts.runner ?? defaultGitRunner;
  const signal = opts.signal ?? new AbortController().signal;
  const cwd = opts.workspaceRoot;

  // 1) status
  const statusRes = await runner(['status', '--porcelain=v1', '-b'], { cwd, signal });
  if (statusRes.code !== 0) {
    return {
      workspaceRoot: cwd,
      isRepo: false,
      error: statusRes.stderr.trim() || `git status exit ${statusRes.code}`,
      status: undefined,
      statusGroups: [],
      log: [],
      selectedPath: undefined,
      selectedStaged: false,
      diff: undefined,
      generatedAt: now,
    };
  }
  const status = parseStatus(statusRes.stdout);
  const statusGroups = groupStatus(status);

  // 2) log
  const logLimit = clamp(opts.logLimit ?? 20, 1, 200);
  const logRes = await runner(
    ['log', `-n`, String(logLimit), '--pretty=format:%H%x1f%an%x1f%ad%x1f%s', '--date=iso'],
    { cwd, signal },
  );
  const log = logRes.code === 0 ? parseLog(logRes.stdout) : [];

  // 3) diff（若指定了 selectedPath）
  let diff: GitPanelInput['diff'] = undefined;
  let selectedPath = opts.selectedPath;
  const selectedStaged = opts.selectedStaged === true;
  if (selectedPath) {
    const safe = safePath(cwd, selectedPath);
    if (safe === null) {
      selectedPath = undefined;
    } else {
      const args = ['diff'];
      if (selectedStaged) args.push('--cached');
      args.push('--', safe);
      const diffRes = await runner(args, { cwd, signal });
      if (diffRes.code === 0) {
        diff = truncDiff(diffRes.stdout, clamp(opts.diffMaxLines ?? 500, 1, 5000));
      } else {
        diff = { text: `(git diff failed: ${diffRes.stderr.trim() || `exit ${diffRes.code}`})`, truncated: false };
      }
    }
  }

  return {
    workspaceRoot: cwd,
    isRepo: true,
    error: undefined,
    status,
    statusGroups,
    log,
    selectedPath,
    selectedStaged,
    diff,
    generatedAt: now,
  };
}

/** XY → group 分类
 *   - 冲突：X=U / Y=U / 含 D+D / A+A 等（porcelain v1 的 unmerged 符号）
 *   - staged：X 非 ' '、非 '?'，且不是冲突
 *   - untracked：XY='??'
 *   - modified：其他（Y 非 ' ' 的工作区变更）
 */
export function groupStatus(s: ParsedStatus): GitPanelStatusGroup[] {
  const staged: GitPanelStatusGroup['entries'] = [];
  const modified: GitPanelStatusGroup['entries'] = [];
  const untracked: GitPanelStatusGroup['entries'] = [];
  const conflict: GitPanelStatusGroup['entries'] = [];
  for (const e of s.entries) {
    const xy = e.xy;
    const X = xy[0];
    const Y = xy[1];
    if (xy === '??') {
      untracked.push(e);
      continue;
    }
    const isConflict =
      X === 'U' ||
      Y === 'U' ||
      (X === 'A' && Y === 'A') ||
      (X === 'D' && Y === 'D');
    if (isConflict) {
      conflict.push(e);
      continue;
    }
    if (X !== ' ' && X !== '?') staged.push(e);
    if (Y !== ' ' && Y !== '?') modified.push(e);
  }
  const groups: GitPanelStatusGroup[] = [];
  if (conflict.length) groups.push({ label: 'Conflicts', kind: 'conflict', entries: conflict });
  if (staged.length) groups.push({ label: 'Staged', kind: 'staged', entries: staged });
  if (modified.length) groups.push({ label: 'Modified', kind: 'modified', entries: modified });
  if (untracked.length) groups.push({ label: 'Untracked', kind: 'untracked', entries: untracked });
  return groups;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function safePath(cwd: string, userPath: string): string | null {
  const p = userPath.trim();
  if (!p) return null;
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(/[\\/]+/).filter(Boolean).join('/');
}

function truncDiff(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { text, truncated: false };
  return {
    text: lines.slice(0, maxLines).join('\n') + `\n… [truncated ${lines.length - maxLines} more line(s)]`,
    truncated: true,
  };
}

// ─────────── 渲染 ───────────

const STYLE = `
.hdr { padding: 12px; border-bottom: 1px solid var(--border); }
.hdr .row { margin-bottom: 6px; }
section { padding: 12px; border-bottom: 1px solid var(--border); }
.file-list { list-style: none; padding: 0; margin: 4px 0 0 0; }
.file-list li { padding: 2px 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; display: flex; align-items: center; gap: 6px; cursor: pointer; }
.file-list li:hover { background: rgba(128,128,128,0.15); }
.file-list li.selected { background: rgba(64,128,255,0.18); }
.xy { font-size: 10px; background: rgba(128,128,128,0.2); padding: 0 4px; border-radius: 3px; min-width: 24px; text-align: center; }
.xy.staged { background: rgba(56,138,52,0.25); color: var(--ok); }
.xy.modified { background: rgba(191,136,3,0.25); color: var(--warn); }
.xy.untracked { background: rgba(128,128,128,0.3); }
.xy.conflict { background: rgba(190,17,0,0.25); color: var(--err); }
.diff-pane { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: pre; overflow: auto; max-height: 60vh; padding: 6px 8px; background: rgba(128,128,128,0.05); border-radius: 3px; }
.diff-pane .add { color: var(--ok); }
.diff-pane .del { color: var(--err); }
.diff-pane .hunk { color: var(--accent); }
.log-entry { font-size: 12px; padding: 4px 0; border-bottom: 1px dashed var(--border); }
.log-entry .sha { font-family: var(--vscode-editor-font-family, monospace); color: var(--muted); margin-right: 6px; }
.log-entry .author { color: var(--muted); font-size: 10px; margin-left: 8px; }
.empty-note { color: var(--muted); font-size: 11px; font-style: italic; }
.err-banner { background: rgba(190, 17, 0, 0.15); color: var(--err); padding: 8px 12px; border-bottom: 1px solid var(--err); font-size: 12px; }
.toggle-row { display: flex; gap: 4px; align-items: center; font-size: 11px; color: var(--muted); margin: 4px 0; }
`;

const SCRIPT = `
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const row = t.closest('[data-action]');
  if (!(row instanceof HTMLElement)) return;
  const action = row.dataset.action;
  if (!action) return;
  const payload = { type: action };
  if (row.dataset.path) payload.path = row.dataset.path;
  if (row.dataset.staged) payload.staged = row.dataset.staged === '1';
  window.__vscode.postMessage(payload);
});
`;

export function buildGitPanelHtml(
  input: GitPanelInput,
  nonce: string,
  cspSource: string,
): string {
  return renderBaseHtml({
    title: 'DualMind · Git',
    nonce,
    cspSource,
    style: STYLE,
    script: SCRIPT,
    body: renderBody(input),
  });
}

function renderBody(input: GitPanelInput): string {
  const ts = new Date(input.generatedAt).toLocaleString();
  const { status } = input;

  const banner = input.error
    ? `<div class="err-banner">❌ ${escapeHtml(input.error)}</div>`
    : '';

  const branchLine = status
    ? renderBranchLine(status)
    : '<span class="muted">(no repo)</span>';

  return `
<h1>DualMind · Git <span class="muted" style="font-weight:normal;margin-left:8px;">${escapeHtml(ts)}</span>
  <span style="float:right;">
    <button data-action="refresh">Reload</button>
  </span>
</h1>

${banner}

<div class="hdr">
  <div class="row"><strong>Workspace:</strong> <code>${escapeHtml(input.workspaceRoot ?? '(none)')}</code></div>
  <div class="row">${branchLine}</div>
</div>

${renderStatusSection(input.statusGroups, input.selectedPath, input.selectedStaged)}
${renderDiffSection(input)}
${renderLogSection(input.log)}
`;
}

function renderBranchLine(s: ParsedStatus): string {
  const br = s.branch ?? '(detached)';
  const up = s.upstream ? ` ↔ ${escapeHtml(s.upstream)}` : '';
  const ab: string[] = [];
  if (s.ahead) ab.push(`ahead ${s.ahead}`);
  if (s.behind) ab.push(`behind ${s.behind}`);
  const lag = ab.length ? ` <span class="pill">${ab.join(', ')}</span>` : '';
  const clean = s.clean ? '<span class="pill ok">clean</span>' : '';
  return `<strong>${escapeHtml(br)}</strong>${up}${lag} ${clean}`;
}

function renderStatusSection(
  groups: readonly GitPanelStatusGroup[],
  selectedPath: string | undefined,
  selectedStaged: boolean,
): string {
  if (groups.length === 0) {
    return `<section>
      <h2>Changes</h2>
      <div class="empty-note">Working tree clean.</div>
    </section>`;
  }
  const parts = groups
    .map((g) => {
      const lis = g.entries
        .map((e) => {
          const full = e.orig ? `${e.orig} -> ${e.path}` : e.path;
          const isSelected = selectedPath === e.path && (g.kind === 'staged') === selectedStaged;
          return `<li class="${isSelected ? 'selected' : ''}" data-action="selectFile" data-path="${escapeHtml(e.path)}" data-staged="${g.kind === 'staged' ? '1' : '0'}">
            <span class="xy ${g.kind}">${escapeHtml(e.xy)}</span>
            <span>${escapeHtml(full)}</span>
            <span style="margin-left:auto;"><button class="linklike" data-action="openFile" data-path="${escapeHtml(e.path)}">open</button></span>
          </li>`;
        })
        .join('');
      return `<div>
        <h2>${escapeHtml(g.label)} (${g.entries.length})</h2>
        <ul class="file-list">${lis}</ul>
      </div>`;
    })
    .join('');
  return `<section>${parts}</section>`;
}

function renderDiffSection(input: GitPanelInput): string {
  if (!input.selectedPath) {
    return `<section>
      <h2>Diff</h2>
      <div class="empty-note">Select a file above to show its diff.</div>
    </section>`;
  }
  if (!input.diff) {
    return `<section>
      <h2>Diff · ${escapeHtml(input.selectedPath)}</h2>
      <div class="empty-note">No diff available.</div>
    </section>`;
  }
  const trunc = input.diff.truncated
    ? '<span class="pill warn">truncated</span>'
    : '';
  const toggle = `
    <span class="toggle-row">
      <button class="linklike" data-action="toggleStaged" data-path="${escapeHtml(input.selectedPath)}" data-staged="${input.selectedStaged ? '1' : '0'}">
        ${input.selectedStaged ? '✓ showing --cached (staged) — click for working tree' : '○ showing working tree — click for --cached (staged)'}
      </button>
    </span>
  `;
  return `<section>
    <h2>Diff · ${escapeHtml(input.selectedPath)} ${trunc}</h2>
    ${toggle}
    <div class="diff-pane">${renderDiffLines(input.diff.text)}</div>
  </section>`;
}

function renderDiffLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const esc = escapeHtml(line);
      if (line.startsWith('@@')) return `<span class="hunk">${esc}</span>`;
      if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="add">${esc}</span>`;
      if (line.startsWith('-') && !line.startsWith('---')) return `<span class="del">${esc}</span>`;
      return esc;
    })
    .join('\n');
}

function renderLogSection(entries: readonly GitLogEntry[]): string {
  if (entries.length === 0) {
    return `<section>
      <h2>Log</h2>
      <div class="empty-note">(no commits)</div>
    </section>`;
  }
  const rows = entries
    .map(
      (e) => `<div class="log-entry">
        <span class="sha">${escapeHtml(e.hash.slice(0, 8))}</span>
        <span>${escapeHtml(e.subject)}</span>
        <span class="author">${escapeHtml(e.author)} · ${escapeHtml(e.date)}</span>
      </div>`,
    )
    .join('');
  return `<section>
    <h2>Log (${entries.length})</h2>
    ${rows}
  </section>`;
}

// ─────────── 命令 ───────────

export async function openGitPanel(context: vscode.ExtensionContext): Promise<vscode.WebviewPanel> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const panel = vscode.window.createWebviewPanel(
    'dualMind.gitPanel',
    'DualMind · Git',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    },
  );

  let selectedPath: string | undefined;
  let selectedStaged = false;

  const rerender = async (): Promise<void> => {
    const input = await collectGitPanelInput({
      workspaceRoot,
      selectedPath,
      selectedStaged,
    });
    panel.webview.html = buildGitPanelHtml(input, genPanelNonce(), panel.webview.cspSource);
  };
  await rerender();

  const sub = panel.webview.onDidReceiveMessage(async (msg) => {
    const m = msg as { type?: string; path?: string; staged?: boolean } | undefined;
    if (!m || !m.type) return;
    if (m.type === 'refresh') {
      await rerender();
    } else if (m.type === 'selectFile' && m.path) {
      selectedPath = m.path;
      selectedStaged = m.staged === true;
      await rerender();
    } else if (m.type === 'toggleStaged' && m.path) {
      selectedPath = m.path;
      selectedStaged = !(m.staged === true);
      await rerender();
    } else if (m.type === 'openFile' && m.path && workspaceRoot) {
      try {
        const abs = path.isAbsolute(m.path) ? m.path : path.join(workspaceRoot, m.path);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
      } catch (e) {
        void vscode.window.showWarningMessage(`打开失败：${(e as Error).message}`);
      }
    }
  });
  panel.onDidDispose(() => sub.dispose());
  return panel;
}
