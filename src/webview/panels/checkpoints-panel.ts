/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C10 · Checkpoint 时间线面板 UI（B-P1-15 · DESIGN §M15 · checkpoint timeline）
 *
 * 在侧边 TreeView（checkpointsTree）的基础上，额外提供一个 Webview 面板：
 * - 按"轮次 / Step"层级展示 checkpoint（`turn:*` / `step:N:<tool>` / 无 label 默认）
 * - 选中两个 checkpoint → Compare Diff：列出文件新增 / 删除 / 修改 / 跳过
 * - 单击 Revert：弹确认 → 调 DualMindChatPanel.revertCheckpoint(id)
 *
 * 纯函数层：
 *   - `groupByTurn(list)`：把 meta 列表分组为 turn 块
 *   - `computeCompareDiff(a, b)`：比较两个 Checkpoint 的 fileSnapshots
 *   - `collectCheckpointsPanelInput(source)`：装配 Input（含 meta list + session id）
 *   - `buildCheckpointsPanelHtml(input, nonce, cspSource)`：产出 HTML
 *
 * 命令层：
 *   - `openCheckpointsPanel(context, source)`：创建 webview + 绑定消息
 */

import * as vscode from 'vscode';
import type {
  Checkpoint,
  CheckpointMeta,
  FileSnapshot,
  RevertResult,
} from '../../core/checkpoints/index.js';
import {
  renderBaseHtml,
  genPanelNonce,
  escapeHtml,
} from './base.js';

// ─────────── 数据层 ───────────

/**
 * 解析 label 为 (turnKey, stepIndex, tool, raw)。
 * 约定（见 coordinator.createStepCheckpoint）：
 *   - `step:<N>:<toolName>` → 属于当前轮的 step 节点；N 升序
 *   - 其他（含 undefined / `turn:*`）→ 视为一轮的收尾 checkpoint
 */
export interface ParsedLabel {
  kind: 'step' | 'final';
  stepIndex?: number;
  tool?: string;
  raw: string;
}

export function parseCheckpointLabel(label: string | undefined): ParsedLabel {
  const raw = label ?? '';
  const m = /^step:(\d+):(.+)$/u.exec(raw);
  if (m) {
    const n = Number.parseInt(m[1]!, 10);
    return {
      kind: 'step',
      stepIndex: Number.isFinite(n) ? n : undefined,
      tool: m[2],
      raw,
    };
  }
  return { kind: 'final', raw };
}

export interface CheckpointTurnGroup {
  /** turnKey：连续 step 段的 stepIndex=1 对应的 checkpoint.createdAt（兜底用 final.createdAt） */
  key: string;
  /** 分组标题（人类可读） */
  title: string;
  /** 该轮起始时间（升序用） */
  startedAt: number;
  /** step 序列，createdAt 升序 */
  steps: CheckpointMeta[];
  /** 可选的 turn 收尾 checkpoint（coordinator.finalizeTurn 产物） */
  final?: CheckpointMeta;
}

/**
 * 把升序的 checkpoint meta list 按"轮"分组：
 * - 连续 step:N 且 N 单调递增 → 同一轮
 * - 出现 step:1 或非 step 节点 → 开启新一轮
 * - final 节点归属"当前轮"（紧挨其前的 step 轮）；若无 step → 自成一轮
 *
 * 约定：入参已按 createdAt 升序。稳定分组，相邻关系判定。
 */
export function groupByTurn(
  metas: readonly CheckpointMeta[],
): CheckpointTurnGroup[] {
  const out: CheckpointTurnGroup[] = [];
  let current: CheckpointTurnGroup | undefined;

  for (const m of metas) {
    const parsed = parseCheckpointLabel(m.label);
    if (parsed.kind === 'step') {
      const isNewTurn =
        !current ||
        current.final !== undefined ||
        current.steps.length === 0 ||
        (parsed.stepIndex !== undefined &&
          parsed.stepIndex <= (current.steps.length > 0 ? parseCheckpointLabel(current.steps[current.steps.length - 1]!.label).stepIndex ?? 0 : 0));
      if (isNewTurn) {
        current = {
          key: m.id,
          title: `Turn @ ${new Date(m.createdAt).toLocaleTimeString(undefined, { hour12: false })}`,
          startedAt: m.createdAt,
          steps: [m],
        };
        out.push(current);
      } else {
        current!.steps.push(m);
      }
    } else {
      // final / 无 label
      if (current && current.final === undefined) {
        current.final = m;
      } else {
        // 独立 final 节点，自成一轮
        const g: CheckpointTurnGroup = {
          key: m.id,
          title: `Turn @ ${new Date(m.createdAt).toLocaleTimeString(undefined, { hour12: false })}`,
          startedAt: m.createdAt,
          steps: [],
          final: m,
        };
        out.push(g);
        current = g; // 闭合；后续 step 会重新开轮
      }
    }
  }
  return out;
}

/** 比较两个 checkpoint 的 fileSnapshots，输出文件级 diff summary。 */
export interface CompareFileItem {
  relPath: string;
  /** added：a 不存在或 wasDeleted，b 存在；removed：反之；modified：hash 不同；unchanged：hash 相同 */
  status: 'added' | 'removed' | 'modified' | 'unchanged' | 'skipped';
  aHash?: string;
  bHash?: string;
  aSize?: number;
  bSize?: number;
}

export interface CompareDiffResult {
  a: { id: string; label?: string; createdAt: number };
  b: { id: string; label?: string; createdAt: number };
  items: CompareFileItem[];
  counts: {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
    skipped: number;
  };
}

export function computeCompareDiff(
  a: Checkpoint,
  b: Checkpoint,
): CompareDiffResult {
  const toMap = (list: readonly FileSnapshot[]): Map<string, FileSnapshot> => {
    const m = new Map<string, FileSnapshot>();
    for (const f of list) m.set(f.relPath, f);
    return m;
  };
  const ma = toMap(a.fileSnapshots);
  const mb = toMap(b.fileSnapshots);
  const allPaths = new Set<string>([...ma.keys(), ...mb.keys()]);
  const items: CompareFileItem[] = [];
  const counts = { added: 0, removed: 0, modified: 0, unchanged: 0, skipped: 0 };
  for (const p of Array.from(allPaths).sort()) {
    const fa = ma.get(p);
    const fb = mb.get(p);
    // skipped 优先：任一侧 skipped → skipped
    if ((fa && fa.skipped) || (fb && fb.skipped)) {
      items.push({
        relPath: p,
        status: 'skipped',
        ...(fa ? { aHash: fa.contentHash, aSize: fa.sizeBytes } : {}),
        ...(fb ? { bHash: fb.contentHash, bSize: fb.sizeBytes } : {}),
      });
      counts.skipped++;
      continue;
    }
    const aExists = fa && !fa.wasDeleted;
    const bExists = fb && !fb.wasDeleted;
    if (!aExists && bExists) {
      items.push({
        relPath: p,
        status: 'added',
        ...(fa ? { aHash: fa.contentHash, aSize: fa.sizeBytes } : {}),
        bHash: fb!.contentHash,
        bSize: fb!.sizeBytes,
      });
      counts.added++;
    } else if (aExists && !bExists) {
      items.push({
        relPath: p,
        status: 'removed',
        aHash: fa!.contentHash,
        aSize: fa!.sizeBytes,
        ...(fb ? { bHash: fb.contentHash, bSize: fb.sizeBytes } : {}),
      });
      counts.removed++;
    } else if (aExists && bExists) {
      if (fa!.contentHash === fb!.contentHash) {
        items.push({
          relPath: p,
          status: 'unchanged',
          aHash: fa!.contentHash,
          bHash: fb!.contentHash,
          aSize: fa!.sizeBytes,
          bSize: fb!.sizeBytes,
        });
        counts.unchanged++;
      } else {
        items.push({
          relPath: p,
          status: 'modified',
          aHash: fa!.contentHash,
          bHash: fb!.contentHash,
          aSize: fa!.sizeBytes,
          bSize: fb!.sizeBytes,
        });
        counts.modified++;
      }
    } else {
      // 两侧都不存在（wasDeleted）— 视为 unchanged
      items.push({
        relPath: p,
        status: 'unchanged',
        aHash: fa?.contentHash ?? '',
        bHash: fb?.contentHash ?? '',
        aSize: fa?.sizeBytes ?? 0,
        bSize: fb?.sizeBytes ?? 0,
      });
      counts.unchanged++;
    }
  }
  return {
    a: { id: a.id, ...(a.label !== undefined ? { label: a.label } : {}), createdAt: a.createdAt },
    b: { id: b.id, ...(b.label !== undefined ? { label: b.label } : {}), createdAt: b.createdAt },
    items,
    counts,
  };
}

// ─────────── Input 收集 ───────────

export interface CheckpointsPanelDataSource {
  getCurrentSessionId(): string | undefined;
  listCheckpoints(): Promise<CheckpointMeta[]>;
  getCheckpointDetails(id: string): Promise<Checkpoint | undefined>;
  revertCheckpoint(id: string): Promise<RevertResult | undefined>;
}

export interface CheckpointsPanelInput {
  sessionId: string | undefined;
  groups: readonly CheckpointTurnGroup[];
  total: number;
  generatedAt: string;
}

export async function collectCheckpointsPanelInput(
  source: CheckpointsPanelDataSource,
): Promise<CheckpointsPanelInput> {
  const sessionId = source.getCurrentSessionId();
  let list: CheckpointMeta[] = [];
  if (sessionId) {
    try {
      list = await source.listCheckpoints();
    } catch {
      list = [];
    }
  }
  const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt);
  const groups = groupByTurn(sorted);
  return {
    sessionId,
    groups,
    total: sorted.length,
    generatedAt: new Date().toISOString(),
  };
}

// ─────────── HTML 渲染 ───────────

export function buildCheckpointsPanelHtml(
  input: CheckpointsPanelInput,
  nonce: string,
  cspSource: string,
  diff?: CompareDiffResult,
): string {
  const header = renderHeader(input);
  const timeline = renderTimeline(input);
  const diffBlock = diff ? renderDiff(diff) : renderDiffPlaceholder();
  const body = `
<h1>DevSeeker · Checkpoint Timeline <span class="muted" style="font-weight:normal;font-size:11px;">${escapeHtml(input.generatedAt)}</span></h1>
${header}
<div class="cp-layout">
  <div class="cp-left">${timeline}</div>
  <div class="cp-right">${diffBlock}</div>
</div>
`;
  const flatItems = input.groups.flatMap((g) =>
    [...g.steps, ...(g.final ? [g.final] : [])].map((m) => ({
      id: m.id,
      label: m.label ?? '',
      createdAt: m.createdAt,
    })),
  );
  // 内联脚本防护：JSON 中的 </ 可能提前终止 <script> 标签，必须转义为 <\/
  const itemsJson = JSON.stringify(flatItems).replace(/<\//g, '<\\/');
  const script = `
const items = ${itemsJson};
const selected = { a: null, b: null };
function updateSelectionBadges() {
  document.querySelectorAll('li.cp-item').forEach((li) => {
    const id = li.getAttribute('data-id');
    li.classList.remove('sel-a','sel-b');
    if (selected.a === id) li.classList.add('sel-a');
    if (selected.b === id) li.classList.add('sel-b');
  });
  document.getElementById('sel-a').textContent = selected.a ? selected.a.slice(0,8) : '—';
  document.getElementById('sel-b').textContent = selected.b ? selected.b.slice(0,8) : '—';
  document.getElementById('btn-compare').disabled = !(selected.a && selected.b && selected.a !== selected.b);
}
document.querySelectorAll('li.cp-item').forEach((li) => {
  li.addEventListener('click', (e) => {
    const id = li.getAttribute('data-id');
    if (!id) return;
    if (e.shiftKey) {
      selected.b = id;
    } else {
      if (selected.a === id) selected.a = null;
      else selected.a = id;
    }
    updateSelectionBadges();
  });
  li.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = li.getAttribute('data-id');
      const act = btn.getAttribute('data-action');
      if (!id || !act) return;
      window.__vscode.postMessage({ type: act, id });
    });
  });
});
document.getElementById('btn-refresh').addEventListener('click', () => {
  window.__vscode.postMessage({ type: 'refresh' });
});
document.getElementById('btn-compare').addEventListener('click', () => {
  if (!selected.a || !selected.b) return;
  window.__vscode.postMessage({ type: 'compare', a: selected.a, b: selected.b });
});
document.getElementById('btn-clear').addEventListener('click', () => {
  selected.a = null; selected.b = null;
  updateSelectionBadges();
  window.__vscode.postMessage({ type: 'clearDiff' });
});
updateSelectionBadges();
`;
  const style = `
.cp-layout { display: grid; grid-template-columns: minmax(260px, 40%) 1fr; gap: 12px; padding: 8px 12px; }
.cp-left { max-height: calc(100vh - 140px); overflow-y: auto; border: 1px solid var(--border); border-radius: 4px; }
.cp-right { max-height: calc(100vh - 140px); overflow-y: auto; border: 1px solid var(--border); border-radius: 4px; padding: 8px; }
.turn-group { border-bottom: 1px solid var(--border); }
.turn-title { padding: 4px 8px; background: rgba(128,128,128,0.08); font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
ul.turn-steps { list-style: none; margin: 0; padding: 0; }
li.cp-item { padding: 6px 8px; border-bottom: 1px dotted var(--border); cursor: pointer; display: flex; gap: 6px; align-items: center; }
li.cp-item:hover { background: rgba(128,128,128,0.10); }
li.cp-item.sel-a { outline: 2px solid var(--accent); outline-offset: -2px; }
li.cp-item.sel-b { outline: 2px solid var(--ok); outline-offset: -2px; }
li.cp-item .cp-time { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--muted); }
li.cp-item .cp-label { flex: 1; font-size: 11.5px; }
li.cp-item .cp-id { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--muted); }
li.cp-item button { padding: 1px 6px; font-size: 10.5px; }
.selbar { display: flex; gap: 8px; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--border); font-size: 11.5px; }
.selbar .pill { padding: 2px 6px; }
.diff-empty { padding: 24px; text-align: center; color: var(--muted); }
.diff-header { padding: 6px 8px; border-bottom: 1px solid var(--border); font-size: 12px; }
.diff-counts { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; font-size: 11px; }
.diff-counts .pill { font-family: var(--vscode-editor-font-family, monospace); }
.diff-file { display: grid; grid-template-columns: 80px 1fr auto; gap: 6px; align-items: center; padding: 3px 8px; border-bottom: 1px dotted var(--border); font-size: 11.5px; }
.diff-file .status { font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; text-transform: uppercase; }
.diff-file .status.added { color: var(--ok); }
.diff-file .status.removed { color: var(--err); }
.diff-file .status.modified { color: var(--warn); }
.diff-file .status.unchanged { color: var(--muted); }
.diff-file .status.skipped { color: var(--muted); font-style: italic; }
.diff-file .relpath { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
.diff-file .sizes { font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; color: var(--muted); }
`;
  return renderBaseHtml({
    title: 'DevSeeker · Checkpoint Timeline',
    nonce,
    cspSource,
    body,
    script,
    style,
  });
}

function renderHeader(input: CheckpointsPanelInput): string {
  const sid = input.sessionId ? escapeHtml(input.sessionId) : '(none)';
  return `
<div class="selbar">
  <span class="muted">session:</span> <code>${sid}</code>
  <span class="muted">total:</span> ${input.total}
  <span style="flex:1;"></span>
  <span class="muted">A:</span><span id="sel-a" class="pill">—</span>
  <span class="muted">B (shift-click):</span><span id="sel-b" class="pill">—</span>
  <button id="btn-compare" disabled>Compare</button>
  <button class="secondary" id="btn-clear">Clear</button>
  <button class="secondary" id="btn-refresh">Refresh</button>
</div>
`;
}

function renderTimeline(input: CheckpointsPanelInput): string {
  if (input.groups.length === 0) {
    return '<div class="empty">no checkpoints</div>';
  }
  // 倒序展示：最新轮在上
  const groups = [...input.groups].reverse();
  return groups
    .map((g) => {
      const items = [
        ...g.steps.map((m) => renderItem(m, false)),
        ...(g.final ? [renderItem(g.final, true)] : []),
      ].join('');
      const count = g.steps.length + (g.final ? 1 : 0);
      return `
<div class="turn-group">
  <div class="turn-title">${escapeHtml(g.title)} · ${count} checkpoint${count === 1 ? '' : 's'}</div>
  <ul class="turn-steps">${items}</ul>
</div>
`;
    })
    .join('');
}

function renderItem(m: CheckpointMeta, isFinal: boolean): string {
  const time = new Date(m.createdAt).toLocaleTimeString(undefined, { hour12: false });
  const parsed = parseCheckpointLabel(m.label);
  const labelHtml = isFinal
    ? `<span class="pill ok">final</span> ${escapeHtml(m.label ?? 'turn')}`
    : parsed.kind === 'step'
      ? `<span class="pill">#${parsed.stepIndex ?? '?'}</span> ${escapeHtml(parsed.tool ?? '')}`
      : `<span class="pill">${escapeHtml(m.label ?? '-')}</span>`;
  return `<li class="cp-item" data-id="${escapeHtml(m.id)}">
    <span class="cp-time">${time}</span>
    <span class="cp-label">${labelHtml} <span class="muted">· ${m.messageCount} msgs · ${m.fileCount} files</span></span>
    <span class="cp-id">${escapeHtml(m.id.slice(0, 8))}</span>
    <button data-action="revert" title="Revert to this checkpoint">Revert</button>
  </li>`;
}

function renderDiffPlaceholder(): string {
  return `<div class="diff-empty">选择两个 checkpoint（普通点击 = A，Shift + 点击 = B）后点 <strong>Compare</strong> 查看差异。</div>`;
}

function renderDiff(d: CompareDiffResult): string {
  const counts = `
<div class="diff-counts">
  <span class="pill ok">+${d.counts.added} added</span>
  <span class="pill err">-${d.counts.removed} removed</span>
  <span class="pill warn">~${d.counts.modified} modified</span>
  <span class="pill">${d.counts.unchanged} unchanged</span>
  <span class="pill">${d.counts.skipped} skipped</span>
</div>
`;
  const rows = d.items
    .map(
      (it) => `<div class="diff-file">
  <span class="status ${it.status}">${it.status}</span>
  <span class="relpath">${escapeHtml(it.relPath)}</span>
  <span class="sizes">${formatSize(it.aSize)} → ${formatSize(it.bSize)}</span>
</div>`,
    )
    .join('');
  return `
<div class="diff-header">
  <div><strong>A</strong> <code>${escapeHtml(d.a.id.slice(0, 8))}</code> ${escapeHtml(d.a.label ?? '')} @ ${new Date(d.a.createdAt).toLocaleTimeString(undefined, { hour12: false })}</div>
  <div><strong>B</strong> <code>${escapeHtml(d.b.id.slice(0, 8))}</code> ${escapeHtml(d.b.label ?? '')} @ ${new Date(d.b.createdAt).toLocaleTimeString(undefined, { hour12: false })}</div>
  ${counts}
</div>
${d.items.length === 0 ? '<div class="diff-empty">no files in either checkpoint</div>' : rows}
`;
}

function formatSize(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

// ─────────── 命令 ───────────

/**
 * 打开 Checkpoint 时间线面板。
 * 若无数据源（DualMindChatPanel 未激活），提示并退出。
 */
export async function openCheckpointsPanel(
  context: vscode.ExtensionContext,
  source: CheckpointsPanelDataSource,
): Promise<vscode.WebviewPanel> {
  const panel = vscode.window.createWebviewPanel(
    'devSeeker.checkpointsPanel',
    'DevSeeker · Checkpoint Timeline',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    },
  );

  let currentInput: CheckpointsPanelInput | undefined;
  let currentDiff: CompareDiffResult | undefined;

  const rerender = async (): Promise<void> => {
    currentInput = await collectCheckpointsPanelInput(source);
    panel.webview.html = buildCheckpointsPanelHtml(
      currentInput,
      genPanelNonce(),
      panel.webview.cspSource,
      currentDiff,
    );
  };
  await rerender();

  const sub = panel.webview.onDidReceiveMessage(async (msg) => {
    const m = msg as { type?: string; id?: string; a?: string; b?: string } | undefined;
    if (!m || !m.type) return;
    if (m.type === 'refresh') {
      currentDiff = undefined;
      await rerender();
      return;
    }
    if (m.type === 'clearDiff') {
      currentDiff = undefined;
      await rerender();
      return;
    }
    if (m.type === 'revert' && m.id) {
      const confirm = await vscode.window.showWarningMessage(
        `确定回滚到 checkpoint ${m.id.slice(0, 8)} 吗？此操作会覆盖已追踪文件并截断对话。`,
        { modal: true },
        '确认回滚',
      );
      if (confirm !== '确认回滚') return;
      try {
        const res = await source.revertCheckpoint(m.id);
        if (!res) {
          void vscode.window.showWarningMessage('回滚未执行（无当前会话）。');
        } else {
          void vscode.window.showInformationMessage(
            `已回滚：${res.filesApplied} 应用 / ${res.filesDeleted} 删除 / ${res.filesSkipped} 跳过。`,
          );
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`回滚失败：${(e as Error).message}`);
      }
      currentDiff = undefined;
      await rerender();
      return;
    }
    if (m.type === 'compare' && m.a && m.b) {
      try {
        const [ca, cb] = await Promise.all([
          source.getCheckpointDetails(m.a),
          source.getCheckpointDetails(m.b),
        ]);
        if (!ca || !cb) {
          void vscode.window.showWarningMessage('Compare 失败：checkpoint 不存在（可能已被删除）');
          return;
        }
        currentDiff = computeCompareDiff(ca, cb);
        await rerender();
      } catch (e) {
        void vscode.window.showErrorMessage(`Compare 失败：${(e as Error).message}`);
      }
    }
  });
  panel.onDidDispose(() => {
    sub.dispose();
  });
  return panel;
}
