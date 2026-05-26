/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C3 · Rules 管理 UI 面板（B-P1-7）
 *
 * 展示：
 *   - Rules 目录：global + workspace 两路的绝对路径
 *   - 所有 Rule 表格：source × kind × priority × name × description × globs × filePath
 *   - 解析 errors 列表（损坏行不阻塞加载）
 *   - 统计：always_on / glob / model_decision 各几条
 *   - 动作：
 *     · Reveal in Explorer（posts openFile with filePath）
 *     · Open global / workspace rules dir
 *     · Reload
 *
 * 不修改规则（视图-only，编辑留给用户在 VSCode 里直接改 md + reload）
 */

import * as vscode from 'vscode';
import { RuleLoader, type Rule } from '../../core/rules/index.js';
import {
  renderBaseHtml,
  genPanelNonce,
  escapeHtml,
  formatNumber,
} from './base.js';

// ─────────── 数据层 ───────────

export interface RulesPanelRule {
  name: string;
  kind: string;
  source: string;
  priority: number;
  description: string;
  globs: string[];
  filePath: string;
  contentChars: number;
}

export interface RulesPanelInput {
  workspaceRoot: string | undefined;
  globalRulesDir: string | undefined;
  workspaceRulesDir: string | undefined;
  rules: RulesPanelRule[];
  errors: Array<{ file: string; message: string }>;
  counts: {
    total: number;
    alwaysOn: number;
    glob: number;
    modelDecision: number;
    bySource: { global: number; workspace: number; nested: number };
  };
  generatedAt: string;
}

export async function collectRulesPanelInput(opts: {
  workspaceRoot: string | undefined;
}): Promise<RulesPanelInput> {
  const loader = new RuleLoader({ workspaceRoot: opts.workspaceRoot });
  const { rules, errors } = await loader.load(true);
  return {
    workspaceRoot: opts.workspaceRoot,
    globalRulesDir: loader.globalRulesDir,
    workspaceRulesDir: loader.rulesDir,
    rules: rules.map(summariseRule),
    errors,
    counts: countRules(rules),
    generatedAt: new Date().toISOString(),
  };
}

function summariseRule(r: Rule): RulesPanelRule {
  return {
    name: r.name,
    kind: r.kind,
    source: r.source,
    priority: r.priority,
    description: r.description ?? '',
    globs: r.globs.slice(),
    filePath: r.filePath,
    contentChars: r.content.length,
  };
}

function countRules(rules: readonly Rule[]): RulesPanelInput['counts'] {
  const bySource = { global: 0, workspace: 0, nested: 0 };
  let alwaysOn = 0;
  let glob = 0;
  let modelDecision = 0;
  for (const r of rules) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    if (r.kind === 'always_on') alwaysOn++;
    else if (r.kind === 'glob') glob++;
    else if (r.kind === 'model_decision') modelDecision++;
  }
  return { total: rules.length, alwaysOn, glob, modelDecision, bySource };
}

// ─────────── 渲染 ───────────

const STYLE = `
.hdr { padding: 12px; border-bottom: 1px solid var(--border); }
.hdr .row { margin-bottom: 6px; }
.stat-pills { display: flex; gap: 6px; flex-wrap: wrap; }
section { padding: 12px; border-bottom: 1px solid var(--border); }
table td.num { text-align: right; font-variant-numeric: tabular-nums; }
code.path { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; word-break: break-all; }
.globs { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--muted); }
.empty-note { color: var(--muted); font-size: 11px; font-style: italic; }
button.linklike { background: transparent; color: var(--accent); padding: 0; text-decoration: underline; cursor: pointer; border: 0; font-size: 11px; }
.err-row td { color: var(--err); }
`;

const SCRIPT = `
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const action = t.dataset.action;
  if (!action) return;
  const payload = { type: action };
  if (t.dataset.path) payload.path = t.dataset.path;
  window.__vscode.postMessage(payload);
});
`;

export function buildRulesPanelHtml(
  input: RulesPanelInput,
  nonce: string,
  cspSource: string,
): string {
  return renderBaseHtml({
    title: 'DualMind · Rules',
    nonce,
    cspSource,
    style: STYLE,
    script: SCRIPT,
    body: renderBody(input),
  });
}

function renderBody(input: RulesPanelInput): string {
  const ts = new Date(input.generatedAt).toLocaleString();
  const { counts } = input;
  return `
<h1>DualMind · Rules <span class="muted" style="font-weight:normal;margin-left:8px;">${escapeHtml(ts)}</span>
  <span style="float:right;">
    <button data-action="refresh">Reload</button>
  </span>
</h1>

<div class="hdr">
  <div class="row"><strong>Workspace:</strong> <code class="path">${escapeHtml(input.workspaceRoot ?? '(none)')}</code></div>
  <div class="row"><strong>Global rules dir:</strong> <code class="path">${escapeHtml(input.globalRulesDir ?? '(disabled)')}</code>
    ${input.globalRulesDir ? `<button class="linklike" data-action="openFolder" data-path="${escapeHtml(input.globalRulesDir)}">open</button>` : ''}
  </div>
  <div class="row"><strong>Workspace rules dir:</strong> <code class="path">${escapeHtml(input.workspaceRulesDir ?? '(n/a)')}</code>
    ${input.workspaceRulesDir ? `<button class="linklike" data-action="openFolder" data-path="${escapeHtml(input.workspaceRulesDir)}">open</button>` : ''}
  </div>
  <div class="row stat-pills">
    <span class="pill">total ${counts.total}</span>
    <span class="pill ok">always_on ${counts.alwaysOn}</span>
    <span class="pill">glob ${counts.glob}</span>
    <span class="pill">model_decision ${counts.modelDecision}</span>
    <span class="pill">global ${counts.bySource.global}</span>
    <span class="pill">workspace ${counts.bySource.workspace}</span>
    ${counts.bySource.nested > 0 ? `<span class="pill">nested ${counts.bySource.nested}</span>` : ''}
  </div>
</div>

${renderRules(input.rules)}

${renderErrors(input.errors)}
`;
}

function renderRules(rules: readonly RulesPanelRule[]): string {
  if (rules.length === 0) {
    return `<section><h2>Rules (0)</h2>
      <div class="empty-note">
        No rules loaded. Drop .md/.mdx files under <code>~/.dualmind/rules/</code>
        or <code>&lt;workspace&gt;/.dualmind/rules/</code> with YAML frontmatter
        (name, kind, description, glob, priority).
      </div>
    </section>`;
  }
  const rows = rules
    .map((r) => {
      const globs = r.globs.length
        ? `<span class="globs">${r.globs.map(escapeHtml).join(', ')}</span>`
        : '<span class="muted">—</span>';
      return `<tr>
        <td><strong>${escapeHtml(r.name)}</strong></td>
        <td><span class="pill">${escapeHtml(r.kind)}</span></td>
        <td>${escapeHtml(r.source)}</td>
        <td class="num">${r.priority}</td>
        <td>${escapeHtml(r.description)}</td>
        <td>${globs}</td>
        <td class="num">${formatNumber(r.contentChars, 0)}</td>
        <td><button class="linklike" data-action="openFile" data-path="${escapeHtml(r.filePath)}">open</button></td>
      </tr>`;
    })
    .join('');
  return `
<section>
  <h2>Rules (${rules.length})</h2>
  <table>
    <thead><tr><th>Name</th><th>Kind</th><th>Source</th><th>Pri</th><th>Description</th><th>Globs</th><th>Chars</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderErrors(errors: readonly { file: string; message: string }[]): string {
  if (errors.length === 0) return '';
  const rows = errors
    .map(
      (e) => `<tr class="err-row">
      <td><code class="path">${escapeHtml(e.file)}</code></td>
      <td>${escapeHtml(e.message)}</td>
      <td><button class="linklike" data-action="openFile" data-path="${escapeHtml(e.file)}">open</button></td>
    </tr>`,
    )
    .join('');
  return `
<section>
  <h2>Parse Errors (${errors.length})</h2>
  <table>
    <thead><tr><th>File</th><th>Message</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

// ─────────── 命令 ───────────

export async function openRulesPanel(context: vscode.ExtensionContext): Promise<vscode.WebviewPanel> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const panel = vscode.window.createWebviewPanel(
    'dualMind.rulesPanel',
    'DualMind · Rules',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    },
  );

  const rerender = async (): Promise<void> => {
    const input = await collectRulesPanelInput({ workspaceRoot });
    panel.webview.html = buildRulesPanelHtml(input, genPanelNonce(), panel.webview.cspSource);
  };
  await rerender();

  const sub = panel.webview.onDidReceiveMessage(async (msg) => {
    const m = msg as { type?: string; path?: string } | undefined;
    if (!m || !m.type) return;
    if (m.type === 'refresh') {
      await rerender();
    } else if (m.type === 'openFile' && m.path) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.path));
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
      } catch (e) {
        void vscode.window.showWarningMessage(`打开失败：${(e as Error).message}`);
      }
    } else if (m.type === 'openFolder' && m.path) {
      try {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.path));
      } catch {
        void vscode.env.openExternal(vscode.Uri.file(m.path));
      }
    }
  });
  panel.onDidDispose(() => sub.dispose());
  return panel;
}
