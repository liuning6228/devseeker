/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C4 · Hooks 配置 UI 面板（B-P1-3）
 *
 * 展示：
 *   - hooks.json 路径 + 存在/缺失状态 + parse error（如果有）
 *   - 所有已加载 Hook 表格：source(config|runtime) × event × name × match × deny × timeoutMs × cwd × command
 *   - 统计 pills：total / by event / deny=true 条数 / has-match 条数
 *
 * 动作：
 *   - Reload（强制重读 hooks.json）
 *   - Open hooks.json（若不存在则创建模板）
 *   - Reveal .devseeker folder
 *   - per-row Open（定位到配置行；简单 openTextDocument 即可）
 *
 * 不修改配置（视图-only，编辑留给用户直接改 JSON）。
 * 无运行期历史：HookManager 当前不保留 run-history，此版本面板只展示声明式配置 + 运行期订阅。
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { loadHookConfig } from '../../core/hooks/index.js';
import type { HookSpec, HookEvent } from '../../core/hooks/types.js';
import {
  renderBaseHtml,
  genPanelNonce,
  escapeHtml,
  formatDuration,
} from './base.js';

// ─────────── 数据层 ───────────

export type HookSource = 'config' | 'runtime';

export interface HooksPanelHook {
  source: HookSource;
  event: HookEvent;
  name: string;
  match: string; // 人类可读：tool=* safety=read_only
  deny: boolean;
  timeoutMs: number;
  cwd: string;
  command: string;
}

export interface HooksPanelInput {
  workspaceRoot: string | undefined;
  configPath: string | undefined;
  configExists: boolean;
  parseError: string | undefined;
  hooks: HooksPanelHook[];
  counts: {
    total: number;
    byEvent: Record<HookEvent, number>;
    denying: number;
    withMatch: number;
    fromRuntime: number;
  };
  generatedAt: string;
}

export async function collectHooksPanelInput(opts: {
  workspaceRoot: string | undefined;
  /** 运行期订阅的 hooks（DualMindChatPanel.current?.listLoadedHooks()）；可选 */
  runtimeHooks?: HookSpec[];
}): Promise<HooksPanelInput> {
  const { workspaceRoot } = opts;
  const configPath = workspaceRoot
    ? path.join(workspaceRoot, '.devseeker', 'hooks.json')
    : undefined;

  let configExists = false;
  if (configPath) {
    try {
      await fs.access(configPath);
      configExists = true;
    } catch {
      configExists = false;
    }
  }

  const loaded = await loadHookConfig(workspaceRoot);
  const configSpecs: HookSpec[] = loaded.config.hooks;
  const runtimeSpecs: HookSpec[] = opts.runtimeHooks ?? [];

  // runtimeSpecs 里往往包含 configSpecs（因为 HookManager.list() = config + runtime）
  // 但入参 runtimeHooks 这里应由调用方过滤，约定只传真正 runtime 的。保持宽松：
  // 若 runtimeSpecs 与 configSpecs 有重叠，去重以 configSpecs 为主。
  const seen = new WeakSet<HookSpec>();
  for (const c of configSpecs) seen.add(c);
  const onlyRuntime = runtimeSpecs.filter((r) => !seen.has(r));

  const hooks: HooksPanelHook[] = [
    ...configSpecs.map((s) => summariseHook(s, 'config', workspaceRoot)),
    ...onlyRuntime.map((s) => summariseHook(s, 'runtime', workspaceRoot)),
  ];

  return {
    workspaceRoot,
    configPath,
    configExists,
    parseError: loaded.error,
    hooks,
    counts: countHooks(hooks),
    generatedAt: new Date().toISOString(),
  };
}

function summariseHook(
  s: HookSpec,
  source: HookSource,
  workspaceRoot: string | undefined,
): HooksPanelHook {
  const m = s.match;
  const matchParts: string[] = [];
  if (m?.tool) matchParts.push(`tool=${m.tool}`);
  if (m?.safetyLevel) matchParts.push(`safety=${m.safetyLevel}`);
  const matchLabel = matchParts.length ? matchParts.join(' ') : '*';
  const isPre = s.event === 'pre_task' || s.event === 'pre_tool_call';
  const deny = isPre ? s.deny !== false : false;
  const cwd = s.cwd ?? (workspaceRoot ?? '(workspace)');
  return {
    source,
    event: s.event,
    name: s.name ?? '(anonymous)',
    match: matchLabel,
    deny,
    timeoutMs: s.timeoutMs ?? 15000,
    cwd,
    command: s.command,
  };
}

function countHooks(hooks: readonly HooksPanelHook[]): HooksPanelInput['counts'] {
  const byEvent: Record<HookEvent, number> = {
    pre_task: 0,
    post_task: 0,
    pre_tool_call: 0,
    post_tool_call: 0,
    on_error: 0,
  };
  let denying = 0;
  let withMatch = 0;
  let fromRuntime = 0;
  for (const h of hooks) {
    byEvent[h.event] = (byEvent[h.event] ?? 0) + 1;
    if (h.deny) denying++;
    if (h.match !== '*') withMatch++;
    if (h.source === 'runtime') fromRuntime++;
  }
  return { total: hooks.length, byEvent, denying, withMatch, fromRuntime };
}

// ─────────── 渲染 ───────────

const STYLE = `
.hdr { padding: 12px; border-bottom: 1px solid var(--border); }
.hdr .row { margin-bottom: 6px; }
.stat-pills { display: flex; gap: 6px; flex-wrap: wrap; }
section { padding: 12px; border-bottom: 1px solid var(--border); }
table td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
table td.cmd { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; word-break: break-all; max-width: 360px; }
code.path { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; word-break: break-all; }
.empty-note { color: var(--muted); font-size: 11px; font-style: italic; }
button.linklike { background: transparent; color: var(--accent); padding: 0; text-decoration: underline; cursor: pointer; border: 0; font-size: 11px; }
.err-banner { background: rgba(190, 17, 0, 0.15); color: var(--err); padding: 8px 12px; border-bottom: 1px solid var(--err); font-size: 12px; }
.warn-banner { background: rgba(191, 136, 3, 0.12); color: var(--warn); padding: 8px 12px; border-bottom: 1px solid var(--warn); font-size: 12px; }
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

export function buildHooksPanelHtml(
  input: HooksPanelInput,
  nonce: string,
  cspSource: string,
): string {
  return renderBaseHtml({
    title: 'DevSeeker · Hooks',
    nonce,
    cspSource,
    style: STYLE,
    script: SCRIPT,
    body: renderBody(input),
  });
}

function renderBody(input: HooksPanelInput): string {
  const ts = new Date(input.generatedAt).toLocaleString();
  const { counts } = input;
  const eventPills = (Object.keys(counts.byEvent) as HookEvent[])
    .filter((ev) => counts.byEvent[ev] > 0)
    .map((ev) => `<span class="pill">${escapeHtml(ev)} ${counts.byEvent[ev]}</span>`)
    .join('');

  const banner = input.parseError
    ? `<div class="err-banner">❌ hooks.json 解析失败：${escapeHtml(input.parseError)}</div>`
    : !input.configExists && input.workspaceRoot
      ? `<div class="warn-banner">⚠️ 未找到 <code>.devseeker/hooks.json</code>。点击 <button class="linklike" data-action="createConfig">Create template</button> 生成默认模板。</div>`
      : '';

  return `
<h1>DevSeeker · Hooks <span class="muted" style="font-weight:normal;margin-left:8px;">${escapeHtml(ts)}</span>
  <span style="float:right;">
    <button data-action="refresh">Reload</button>
  </span>
</h1>

${banner}

<div class="hdr">
  <div class="row"><strong>Workspace:</strong> <code class="path">${escapeHtml(input.workspaceRoot ?? '(none)')}</code></div>
  <div class="row"><strong>Config file:</strong>
    <code class="path">${escapeHtml(input.configPath ?? '(n/a)')}</code>
    ${
      input.configPath
        ? `<button class="linklike" data-action="openFile" data-path="${escapeHtml(input.configPath)}">${input.configExists ? 'open' : 'create &amp; open'}</button>`
        : ''
    }
  </div>
  <div class="row stat-pills">
    <span class="pill">total ${counts.total}</span>
    ${eventPills}
    ${counts.denying > 0 ? `<span class="pill warn">deny ${counts.denying}</span>` : ''}
    ${counts.withMatch > 0 ? `<span class="pill">matchers ${counts.withMatch}</span>` : ''}
    ${counts.fromRuntime > 0 ? `<span class="pill ok">runtime ${counts.fromRuntime}</span>` : ''}
  </div>
</div>

${renderHooks(input.hooks)}
`;
}

function renderHooks(hooks: readonly HooksPanelHook[]): string {
  if (hooks.length === 0) {
    return `<section><h2>Hooks (0)</h2>
      <div class="empty-note">
        No hooks configured. Add entries to <code>.devseeker/hooks.json</code>
        (schema: <code>{ hooks: [{ event, command, match?, deny?, timeoutMs?, cwd?, name? }] }</code>).
      </div>
    </section>`;
  }
  const rows = hooks
    .map((h) => {
      const denyPill = h.deny
        ? '<span class="pill warn">deny</span>'
        : '<span class="pill">observe</span>';
      const sourcePill =
        h.source === 'runtime'
          ? '<span class="pill ok">runtime</span>'
          : '<span class="pill">config</span>';
      return `<tr>
        <td>${sourcePill}</td>
        <td><span class="pill">${escapeHtml(h.event)}</span></td>
        <td><strong>${escapeHtml(h.name)}</strong></td>
        <td>${escapeHtml(h.match)}</td>
        <td>${denyPill}</td>
        <td class="num">${escapeHtml(formatDuration(h.timeoutMs))}</td>
        <td><code class="path">${escapeHtml(h.cwd)}</code></td>
        <td class="cmd">${escapeHtml(h.command)}</td>
      </tr>`;
    })
    .join('');
  return `
<section>
  <h2>Hooks (${hooks.length})</h2>
  <table>
    <thead><tr><th>Source</th><th>Event</th><th>Name</th><th>Match</th><th>Deny</th><th>Timeout</th><th>Cwd</th><th>Command</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

// ─────────── 命令 ───────────

const HOOKS_JSON_TEMPLATE = `{
  // .devseeker/hooks.json
  // 完整字段：event | command | match? | deny? | timeoutMs? | cwd? | name?
  "hooks": [
    // 示例：拒绝对 package-lock.json 的写入
    // {
    //   "event": "pre_tool_call",
    //   "match": { "tool": "apply_patch" },
    //   "command": "node -e \\"let j=require('fs').readFileSync(0,'utf8');process.exit(JSON.parse(j).argsJson.includes('package-lock.json')?1:0)\\"",
    //   "deny": true,
    //   "name": "block-package-lock-edit"
    // }
  ]
}
`;

export async function openHooksPanel(
  context: vscode.ExtensionContext,
  getRuntimeHooks?: () => Promise<HookSpec[]> | HookSpec[],
): Promise<vscode.WebviewPanel> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const panel = vscode.window.createWebviewPanel(
    'devSeeker.hooksPanel',
    'DevSeeker · Hooks',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    },
  );

  const rerender = async (): Promise<void> => {
    const runtimeHooks = (await Promise.resolve(getRuntimeHooks?.() ?? [])) as HookSpec[];
    const input = await collectHooksPanelInput({ workspaceRoot, runtimeHooks });
    panel.webview.html = buildHooksPanelHtml(input, genPanelNonce(), panel.webview.cspSource);
  };
  await rerender();

  const sub = panel.webview.onDidReceiveMessage(async (msg) => {
    const m = msg as { type?: string; path?: string } | undefined;
    if (!m || !m.type) return;
    if (m.type === 'refresh') {
      await rerender();
    } else if (m.type === 'openFile' && m.path) {
      await openOrCreate(m.path);
      await rerender();
    } else if (m.type === 'createConfig') {
      if (!workspaceRoot) {
        void vscode.window.showWarningMessage('未打开工作区，无法创建 hooks.json');
        return;
      }
      const p = path.join(workspaceRoot, '.devseeker', 'hooks.json');
      await openOrCreate(p);
      await rerender();
    }
  });
  panel.onDidDispose(() => sub.dispose());
  return panel;
}

async function openOrCreate(filePath: string): Promise<void> {
  try {
    try {
      await fs.access(filePath);
    } catch {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, HOOKS_JSON_TEMPLATE, 'utf8');
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
  } catch (e) {
    void vscode.window.showErrorMessage(`打开/创建 hooks.json 失败：${(e as Error).message}`);
  }
}
