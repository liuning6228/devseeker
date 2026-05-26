/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C1 · Context 可视化面板（B-P1-5）
 *
 * 目标：把当前 workspace 真实数据喂给 `PromptBuilder.build()`，可视化呈现：
 *   - L0/L1/L2/L3 各层字符数 + 估算 token 数 + 前缀哈希（cacheKeys）
 *   - PromptBuilder 版本
 *   - mode / skills / rules / memories 摘要表（证明数据没漂移）
 *   - 若发生 token 裁剪，展示 TruncationReport
 *
 * 非目标：
 *   - 不展示 L 各层原文（L0 约 4KB，UI 里展开没意义；另外 L2 里 memory 可能含隐私）
 *   - 不做修改动作（只读面板）
 *
 * 拆分：
 *   - `buildContextPanelHtml(input, nonce, cspSource)` 纯函数 → 可单测
 *   - `collectContextPanelInput(opts)` 异步采集真实数据 → 依赖 RuleLoader/SkillLoader/MemoryStore
 *   - `openContextPanel(context)` 注册命令的薄胶水层
 */

import * as vscode from 'vscode';
import {
  PromptBuilder,
  PROMPT_BUILDER_VERSION,
  dumpPromptSnapshot,
  estimateTokens,
  type PromptSnapshot,
} from '../../core/prompts/index.js';
import { RuleLoader, selectForPrompt, type Rule } from '../../core/rules/index.js';
import { SkillLoader, BUILTIN_SKILLS, type Skill } from '../../core/skills/index.js';
import { MemoryStore } from '../../core/memory/index.js';
import type { MemoryRecord } from '../../core/memory/types.js';
import type { Mode } from '../../core/modes/index.js';
import {
  renderBaseHtml,
  openSimplePanel,
  genPanelNonce,
  escapeHtml,
  formatNumber,
} from './base.js';

// ─────────── 数据层 ───────────

export interface ContextPanelRuleSummary {
  name: string;
  kind: string;
  source: string;
  priority: number;
  descriptionChars: number;
  contentChars: number;
}

export interface ContextPanelSkillSummary {
  name: string;
  description: string;
  contentChars: number;
}

export interface ContextPanelMemorySummary {
  id: string;
  title: string;
  category: string;
  scope: string;
  contentChars: number;
}

export interface ContextPanelInput {
  /** 当前工作区路径；未打开工作区时 undefined */
  workspaceRoot: string | undefined;
  /** 当前 Mode */
  mode: Mode;
  /** Skills 概览（已按 name 升序） */
  skills: ContextPanelSkillSummary[];
  /** 全量规则（尚未按 glob 选中） */
  allRules: ContextPanelRuleSummary[];
  /** selectForPrompt 命中后的规则（进入 L2） */
  selectedRules: ContextPanelRuleSummary[];
  /** 当前记忆（按 updatedAt 倒序） */
  memories: ContextPanelMemorySummary[];
  /** PromptBuilder 输出的 snapshot（含 cacheKeys + lengths） */
  snapshot: PromptSnapshot;
  /** 估算 token（各层 + full） */
  tokens: { L0: number; L1: number; L2: number; L3: number; full: number };
  /** 采集 / 构建过程中的降级/告警信息（空数组表示完全正常） */
  warnings: string[];
  /** 构建时间戳（ISO） */
  generatedAt: string;
}

/**
 * 采集真实数据并跑一次 PromptBuilder.build，产出 ContextPanelInput。
 *
 * 任何一源失败（rules/skills/memories）都不会抛出，而是降级记入 warnings。
 */
export async function collectContextPanelInput(opts: {
  workspaceRoot: string | undefined;
  mode: Mode;
}): Promise<ContextPanelInput> {
  const { workspaceRoot, mode } = opts;
  const warnings: string[] = [];

  // Rules
  let allRules: Rule[] = [];
  let selectedRules: Rule[] = [];
  try {
    const loader = new RuleLoader({ workspaceRoot });
    await loader.load();
    allRules = loader.list();
    const activeFile = vscode.window.activeTextEditor
      ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri, false)
      : undefined;
    const recentFiles = vscode.workspace.textDocuments
      .filter((d) => d.uri.scheme === 'file')
      .slice(0, 20)
      .map((d) => vscode.workspace.asRelativePath(d.uri, false));
    selectedRules =
      allRules.length > 0
        ? selectForPrompt(allRules, {
            ...(activeFile !== undefined ? { activeFile } : {}),
            recentFiles,
          })
        : [];
  } catch (e) {
    warnings.push(`rules: ${(e as Error).message}`);
  }

  // Skills
  let skills: Skill[] = [];
  try {
    const skillLoader = new SkillLoader({ workspaceRoot, builtinSkills: BUILTIN_SKILLS });
    await skillLoader.load();
    skills = skillLoader.list();
  } catch (e) {
    warnings.push(`skills: ${(e as Error).message}`);
  }

  // Memories
  let memories: MemoryRecord[] = [];
  try {
    const store = new MemoryStore({ workspaceRoot });
    memories = await store.list();
  } catch (e) {
    warnings.push(`memories: ${(e as Error).message}`);
  }

  // 构建 prompt（不含 L3 attachments，保持面板只读、轻量）
  const layered = PromptBuilder.build({
    mode,
    skills,
    selectedRules,
    allRules,
    memories,
  });
  const snapshot = dumpPromptSnapshot(layered);
  const tokens = {
    L0: estimateTokens(layered.L0),
    L1: estimateTokens(layered.L1),
    L2: estimateTokens(layered.L2),
    L3: estimateTokens(layered.L3),
    full: estimateTokens(layered.full),
  };

  return {
    workspaceRoot,
    mode,
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      contentChars: s.content.length,
    })),
    allRules: allRules.map(summariseRule),
    selectedRules: selectedRules.map(summariseRule),
    memories: memories.map((m) => ({
      id: m.id,
      title: m.title,
      category: m.category,
      scope: m.scope,
      contentChars: m.content.length,
    })),
    snapshot,
    tokens,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

function summariseRule(r: Rule): ContextPanelRuleSummary {
  return {
    name: r.name,
    kind: r.kind,
    source: r.source,
    priority: r.priority,
    descriptionChars: (r.description ?? '').length,
    contentChars: r.content.length,
  };
}

// ─────────── HTML 渲染 ───────────

const STYLE = `
.hdr { padding: 12px; border-bottom: 1px solid var(--border); display: flex; gap: 16px; flex-wrap: wrap; align-items: baseline; }
.hdr .muted { font-size: 11px; }
section { padding: 12px; border-bottom: 1px solid var(--border); }
.layers { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.layer { border: 1px solid var(--border); border-radius: 4px; padding: 10px; }
.layer h3 { margin: 0 0 6px; font-size: 12px; display: flex; justify-content: space-between; align-items: center; }
.layer .kv { display: flex; justify-content: space-between; font-size: 11px; margin: 2px 0; color: var(--muted); }
.layer .hash { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; word-break: break-all; color: var(--accent); }
.warnings { color: var(--warn); font-size: 12px; }
.warnings ul { margin: 4px 0 0; padding-left: 20px; }
.empty-note { color: var(--muted); font-size: 11px; font-style: italic; }
table td.num { text-align: right; font-variant-numeric: tabular-nums; }
`;

const SCRIPT = `
const btn = document.getElementById('refreshBtn');
if (btn) btn.addEventListener('click', () => window.__vscode.postMessage({ type: 'refresh' }));
`;

export function buildContextPanelHtml(
  input: ContextPanelInput,
  nonce: string,
  cspSource: string,
): string {
  const body = renderBody(input);
  return renderBaseHtml({
    title: 'DualMind · Context',
    nonce,
    cspSource,
    body,
    style: STYLE,
    script: SCRIPT,
  });
}

function renderBody(input: ContextPanelInput): string {
  const generatedAt = new Date(input.generatedAt).toLocaleString();
  return `
<h1>DualMind · Context <span class="muted" style="font-weight:normal;margin-left:8px;">${escapeHtml(generatedAt)}</span></h1>

<div class="hdr">
  <div><strong>Mode:</strong> <span class="pill">${escapeHtml(input.mode)}</span></div>
  <div><strong>Workspace:</strong> <code>${escapeHtml(input.workspaceRoot ?? '(none)')}</code></div>
  <div><strong>PromptBuilder:</strong> <span class="pill">v${escapeHtml(input.snapshot.version)}</span></div>
  <div style="margin-left:auto;"><button id="refreshBtn">Refresh</button></div>
</div>

${renderWarnings(input.warnings)}

<section>
  <h2>Layers</h2>
  <div class="layers">
    ${renderLayerCard('L0', 'identity & protocol (stable)', input.snapshot.lengths.L0, input.tokens.L0, input.snapshot.cacheKeys.L0)}
    ${renderLayerCard('L1', 'tools + mode + skills', input.snapshot.lengths.L1, input.tokens.L1, input.snapshot.cacheKeys.L0L1)}
    ${renderLayerCard('L2', 'rules + memory overview', input.snapshot.lengths.L2, input.tokens.L2, input.snapshot.cacheKeys.L0L1L2)}
    ${renderLayerCard('L3', 'attachments (preview: empty)', input.snapshot.lengths.L3, input.tokens.L3, input.snapshot.cacheKeys.full)}
  </div>
  <p class="muted" style="margin-top:10px;">
    <strong>Full:</strong> ${formatNumber(input.snapshot.lengths.full, 0)} chars ·
    ~${formatNumber(input.tokens.full, 0)} tokens ·
    full hash <code>${escapeHtml(input.snapshot.cacheKeys.full)}</code>
  </p>
</section>

${renderSkillsSection(input.skills)}
${renderRulesSection(input.allRules, input.selectedRules)}
${renderMemoriesSection(input.memories)}
`;
}

function renderLayerCard(
  tag: string,
  subtitle: string,
  chars: number,
  tokens: number,
  hash: string,
): string {
  return `
    <div class="layer">
      <h3>${escapeHtml(tag)} <span class="pill">${escapeHtml(hash)}</span></h3>
      <div class="muted" style="font-size:11px;margin-bottom:6px;">${escapeHtml(subtitle)}</div>
      <div class="kv"><span>chars</span><span>${formatNumber(chars, 0)}</span></div>
      <div class="kv"><span>~tokens</span><span>${formatNumber(tokens, 0)}</span></div>
    </div>`;
}

function renderWarnings(warnings: readonly string[]): string {
  if (warnings.length === 0) return '';
  const items = warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  return `<section class="warnings"><h2>Warnings</h2><ul>${items}</ul></section>`;
}

function renderSkillsSection(skills: readonly ContextPanelSkillSummary[]): string {
  if (skills.length === 0) {
    return `<section><h2>Skills (0)</h2><div class="empty-note">(no skills discovered)</div></section>`;
  }
  const rows = skills
    .map(
      (s) => `<tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.description)}</td>
      <td class="num">${formatNumber(s.contentChars, 0)}</td>
    </tr>`,
    )
    .join('');
  return `
<section>
  <h2>Skills (${skills.length})</h2>
  <table>
    <thead><tr><th>Name</th><th>Description</th><th>Chars</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderRulesSection(
  all: readonly ContextPanelRuleSummary[],
  selected: readonly ContextPanelRuleSummary[],
): string {
  if (all.length === 0) {
    return `<section><h2>Rules (0)</h2><div class="empty-note">(no rules loaded from global + workspace)</div></section>`;
  }
  const selectedNames = new Set(selected.map((r) => r.name));
  const rows = all
    .map((r) => {
      const inL2 = selectedNames.has(r.name);
      const pill = inL2 ? `<span class="pill ok">L2</span>` : `<span class="pill">-</span>`;
      return `<tr>
        <td>${pill}</td>
        <td>${escapeHtml(r.name)}</td>
        <td><span class="pill">${escapeHtml(r.kind)}</span></td>
        <td>${escapeHtml(r.source)}</td>
        <td class="num">${r.priority}</td>
        <td class="num">${formatNumber(r.contentChars, 0)}</td>
      </tr>`;
    })
    .join('');
  return `
<section>
  <h2>Rules (${all.length} total · ${selected.length} in L2)</h2>
  <table>
    <thead><tr><th></th><th>Name</th><th>Kind</th><th>Source</th><th>Pri</th><th>Chars</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderMemoriesSection(memories: readonly ContextPanelMemorySummary[]): string {
  if (memories.length === 0) {
    return `<section><h2>Memories (0)</h2><div class="empty-note">(store is empty — no memories contribute to L2)</div></section>`;
  }
  const rows = memories
    .slice(0, 50)
    .map(
      (m) => `<tr>
      <td>${escapeHtml(m.title)}</td>
      <td><span class="pill">${escapeHtml(m.category)}</span></td>
      <td>${escapeHtml(m.scope)}</td>
      <td class="num">${formatNumber(m.contentChars, 0)}</td>
    </tr>`,
    )
    .join('');
  const overflow =
    memories.length > 50
      ? `<div class="muted" style="font-size:11px;margin-top:4px;">(truncated to 50 of ${memories.length})</div>`
      : '';
  return `
<section>
  <h2>Memories (${memories.length})</h2>
  <table>
    <thead><tr><th>Title</th><th>Category</th><th>Scope</th><th>Chars</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${overflow}
</section>`;
}

// ─────────── 命令胶水 ───────────

/** 打开 Context 面板（可由 refresh 消息触发再渲染） */
export async function openContextPanel(
  context: vscode.ExtensionContext,
  getMode: () => Mode,
): Promise<vscode.WebviewPanel> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const panel = vscode.window.createWebviewPanel(
    'dualMind.contextPanel',
    'DualMind · Context',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    },
  );

  const rerender = async (): Promise<void> => {
    const input = await collectContextPanelInput({ workspaceRoot, mode: getMode() });
    panel.webview.html = buildContextPanelHtml(input, genPanelNonce(), panel.webview.cspSource);
  };

  await rerender();

  const sub = panel.webview.onDidReceiveMessage((msg) => {
    if ((msg as { type?: string } | undefined)?.type === 'refresh') {
      void rerender();
    }
  });
  panel.onDidDispose(() => sub.dispose());

  // 引用以免 barrel 里 dead import
  void PROMPT_BUILDER_VERSION;
  void openSimplePanel;

  return panel;
}
