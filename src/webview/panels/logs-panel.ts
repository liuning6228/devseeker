/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C9 · 日志面板 UI（B-P1-14 · DESIGN §M11.1 · logs panel）
 *
 * 读取 `.dualmind/logs/runtime.log` + `.dualmind/logs/error.log`（pino NDJSON），
 * 展示最近 N 条日志，支持按 level / module / 关键字过滤 + 实时 tail（fs.watch debounce）。
 *
 * 纯函数层：
 *   - `parseNdjsonLine(line)`：容忍非法行，返回 null。
 *   - `filterLogEntries(entries, filter)`：按 level / module / keyword 过滤。
 *   - `collectLogPanelInput(opts)`：读取两份日志末尾 N 行，返回合并排序后的 entries。
 *   - `buildLogsPanelHtml(input, nonce, cspSource)`：产出 HTML。
 *
 * 命令层：
 *   - `openLogsPanel(context)`：创建 webview + fs.watch tail。
 *
 * 设计约束：
 *   - 日志文件可能很大，只取末尾 `maxBytes`（默认 256KB）转 NDJSON。
 *   - fs.watch 的 change 事件会被 debounce 500ms 后 refresh。
 *   - 不修改日志内容（视图-only）；不往回传入文件（CSP connect-src 'none'）。
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import {
  renderBaseHtml,
  genPanelNonce,
  escapeHtml,
} from './base.js';

// ─────────── 数据层 ───────────

export type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** pino level（数字）→ 名字映射。未知值返回 'info'。 */
export const LEVEL_MAP: Record<number, LogLevelName> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

export interface LogEntry {
  /** ISO 时间（若原 pino 是 epoch ms 数，这里格式化） */
  time: string;
  /** 时间的 epoch ms，用于排序 */
  tsMs: number;
  level: LogLevelName;
  module: string;
  msg: string;
  /** 剩余字段（context），已剥掉 time/level/module/msg */
  extra: Record<string, unknown>;
  /** 源文件：runtime 或 error */
  source: 'runtime' | 'error';
  /** 原 JSON 行（保留做展示） */
  raw: string;
}

export interface LogsPanelInput {
  workspaceRoot: string | undefined;
  runtimePath: string | undefined;
  errorPath: string | undefined;
  runtimeExists: boolean;
  errorExists: boolean;
  entries: readonly LogEntry[];
  /** 读取 tail 时截断的字节数 */
  maxBytes: number;
  /** 按源分组统计 */
  counts: {
    total: number;
    byLevel: Record<LogLevelName, number>;
    fromRuntime: number;
    fromError: number;
  };
  generatedAt: string;
}

export interface LogFilter {
  /** 若为空 → 全部 */
  levels?: readonly LogLevelName[];
  /** 子串匹配 module（大小写不敏感） */
  module?: string;
  /** 子串匹配 msg（大小写不敏感） */
  keyword?: string;
}

/** 解析一行 NDJSON。容忍非法/空行。 */
export function parseNdjsonLine(line: string, source: 'runtime' | 'error'): LogEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const rawTime = obj['time'];
  let tsMs: number;
  if (typeof rawTime === 'number' && Number.isFinite(rawTime)) {
    tsMs = rawTime;
  } else if (typeof rawTime === 'string') {
    const parsed = Date.parse(rawTime);
    tsMs = Number.isFinite(parsed) ? parsed : Date.now();
  } else {
    tsMs = Date.now();
  }
  const time = new Date(tsMs).toISOString();

  const rawLevel = obj['level'];
  let level: LogLevelName = 'info';
  if (typeof rawLevel === 'number' && LEVEL_MAP[rawLevel]) {
    level = LEVEL_MAP[rawLevel]!;
  } else if (typeof rawLevel === 'string') {
    const l = rawLevel.toLowerCase();
    if (l === 'trace' || l === 'debug' || l === 'info' || l === 'warn' || l === 'error' || l === 'fatal') {
      level = l;
    }
  }

  const module =
    typeof obj['module'] === 'string' ? (obj['module'] as string) : '(unknown)';
  const msg = typeof obj['msg'] === 'string' ? (obj['msg'] as string) : '';

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'time' || k === 'level' || k === 'module' || k === 'msg' || k === 'hostname' || k === 'pid' || k === 'v') continue;
    extra[k] = v;
  }

  return { time, tsMs, level, module, msg, extra, source, raw: trimmed };
}

/** 按 filter 过滤 entries；不改顺序。 */
export function filterLogEntries(
  entries: readonly LogEntry[],
  filter: LogFilter = {},
): LogEntry[] {
  const levels = filter.levels && filter.levels.length > 0 ? new Set(filter.levels) : undefined;
  const modLc = filter.module?.toLowerCase().trim();
  const kwLc = filter.keyword?.toLowerCase().trim();
  const out: LogEntry[] = [];
  for (const e of entries) {
    if (levels && !levels.has(e.level)) continue;
    if (modLc && modLc.length > 0 && !e.module.toLowerCase().includes(modLc)) continue;
    if (kwLc && kwLc.length > 0) {
      const haystack = (e.msg + ' ' + JSON.stringify(e.extra)).toLowerCase();
      if (!haystack.includes(kwLc)) continue;
    }
    out.push(e);
  }
  return out;
}

/** 读取文件的末尾字节（简化：若文件小于 maxBytes 则全读）。 */
async function readTail(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.stat(filePath);
  const size = stat.size;
  if (size === 0) return '';
  const start = Math.max(0, size - maxBytes);
  const handle = await fs.open(filePath, 'r');
  try {
    const length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    let text = buf.toString('utf8');
    // 丢掉首行（可能不完整）
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    await handle.close();
  }
}

export interface CollectLogPanelOptions {
  workspaceRoot: string | undefined;
  /** 读取 tail 的最大字节；默认 256KB */
  maxBytes?: number;
  /** 合并后最终保留的最大条数；默认 500 */
  maxEntries?: number;
  /** 依赖注入：读取 tail；测试可 stub */
  readTail?: (filePath: string) => Promise<string>;
  /** 依赖注入：存在性检查；测试可 stub */
  exists?: (filePath: string) => Promise<boolean>;
}

export async function collectLogPanelInput(
  opts: CollectLogPanelOptions,
): Promise<LogsPanelInput> {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const maxEntries = opts.maxEntries ?? 500;
  const runtimePath = opts.workspaceRoot
    ? path.join(opts.workspaceRoot, '.dualmind', 'logs', 'runtime.log')
    : undefined;
  const errorPath = opts.workspaceRoot
    ? path.join(opts.workspaceRoot, '.dualmind', 'logs', 'error.log')
    : undefined;

  const existsFn =
    opts.exists ??
    (async (p: string) => {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    });

  const readFn =
    opts.readTail ?? ((p: string) => readTail(p, maxBytes));

  const runtimeExists = runtimePath ? await existsFn(runtimePath) : false;
  const errorExists = errorPath ? await existsFn(errorPath) : false;

  const entries: LogEntry[] = [];
  if (runtimeExists && runtimePath) {
    try {
      const text = await readFn(runtimePath);
      for (const line of text.split(/\r?\n/)) {
        const e = parseNdjsonLine(line, 'runtime');
        if (e) entries.push(e);
      }
    } catch {
      /* swallow */
    }
  }
  if (errorExists && errorPath) {
    try {
      const text = await readFn(errorPath);
      for (const line of text.split(/\r?\n/)) {
        const e = parseNdjsonLine(line, 'error');
        if (e) entries.push(e);
      }
    } catch {
      /* swallow */
    }
  }
  entries.sort((a, b) => a.tsMs - b.tsMs);
  const sliced = entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries;

  return {
    workspaceRoot: opts.workspaceRoot,
    runtimePath,
    errorPath,
    runtimeExists,
    errorExists,
    entries: sliced,
    maxBytes,
    counts: countEntries(sliced),
    generatedAt: new Date().toISOString(),
  };
}

function countEntries(entries: readonly LogEntry[]): LogsPanelInput['counts'] {
  const byLevel: Record<LogLevelName, number> = {
    trace: 0,
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
    fatal: 0,
  };
  let runtimeCount = 0;
  let errorCount = 0;
  for (const e of entries) {
    byLevel[e.level]++;
    if (e.source === 'runtime') runtimeCount++;
    else errorCount++;
  }
  return {
    total: entries.length,
    byLevel,
    fromRuntime: runtimeCount,
    fromError: errorCount,
  };
}

// ─────────── HTML 渲染 ───────────

export function buildLogsPanelHtml(
  input: LogsPanelInput,
  nonce: string,
  cspSource: string,
): string {
  const header = renderHeader(input);
  const filterBar = renderFilterBar();
  const table = renderTable(input.entries);
  const body = `
<h1>DualMind · Logs <span class="muted" style="font-weight:normal;font-size:11px;">${escapeHtml(input.generatedAt)}</span></h1>
${header}
${filterBar}
${table}
`;
  const script = `
const rowsData = ${JSON.stringify(input.entries.map((e) => ({
    time: e.time,
    level: e.level,
    module: e.module,
    msg: e.msg,
    source: e.source,
    extra: e.extra,
  })))};
function applyFilter() {
  const levels = Array.from(document.querySelectorAll('input[data-level]:checked')).map((c) => c.getAttribute('data-level'));
  const mod = document.getElementById('f-module').value.toLowerCase().trim();
  const kw = document.getElementById('f-keyword').value.toLowerCase().trim();
  const rows = document.querySelectorAll('tbody tr.log-row');
  let shown = 0;
  rows.forEach((tr, i) => {
    const d = rowsData[i];
    let keep = true;
    if (levels.length > 0 && !levels.includes(d.level)) keep = false;
    if (keep && mod && !d.module.toLowerCase().includes(mod)) keep = false;
    if (keep && kw) {
      const h = (d.msg + ' ' + JSON.stringify(d.extra)).toLowerCase();
      if (!h.includes(kw)) keep = false;
    }
    tr.style.display = keep ? '' : 'none';
    if (keep) shown++;
  });
  document.getElementById('shown-count').textContent = String(shown);
}
document.querySelectorAll('input[data-level]').forEach((c) => c.addEventListener('change', applyFilter));
document.getElementById('f-module').addEventListener('input', applyFilter);
document.getElementById('f-keyword').addEventListener('input', applyFilter);
document.getElementById('btn-refresh').addEventListener('click', () => {
  window.__vscode.postMessage({ type: 'refresh' });
});
document.getElementById('btn-clear-filters').addEventListener('click', () => {
  document.querySelectorAll('input[data-level]').forEach((c) => c.checked = false);
  document.getElementById('f-module').value = '';
  document.getElementById('f-keyword').value = '';
  applyFilter();
});
document.getElementById('btn-open-runtime').addEventListener('click', () => {
  window.__vscode.postMessage({ type: 'openFile', source: 'runtime' });
});
document.getElementById('btn-open-error').addEventListener('click', () => {
  window.__vscode.postMessage({ type: 'openFile', source: 'error' });
});
applyFilter();
`;
  const style = `
.top-bar { display: flex; gap: 10px; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--border); flex-wrap: wrap; font-size: 12px; }
.top-bar input[type="text"] { padding: 3px 6px; border: 1px solid var(--border); background: transparent; color: var(--fg); border-radius: 3px; font-family: var(--vscode-font-family); min-width: 120px; }
.top-bar label { display: inline-flex; gap: 3px; align-items: center; cursor: pointer; }
.level-pill { padding: 1px 5px; border-radius: 8px; font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); }
.level-trace { color: var(--muted); }
.level-debug { color: var(--muted); }
.level-info { color: var(--accent); }
.level-warn { color: var(--warn); }
.level-error { color: var(--err); font-weight: 600; }
.level-fatal { color: var(--err); font-weight: 700; text-transform: uppercase; }
table.logs { font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px; }
table.logs td.time { white-space: nowrap; color: var(--muted); }
table.logs td.module { color: var(--muted); }
table.logs td.msg { word-break: break-word; }
table.logs td.extra { color: var(--muted); font-size: 10.5px; white-space: pre-wrap; }
.log-source-runtime { border-left: 3px solid transparent; }
.log-source-error { border-left: 3px solid var(--err); }
`;
  return renderBaseHtml({
    title: 'DualMind · Logs',
    nonce,
    cspSource,
    body,
    script,
    style,
  });
}

function renderHeader(input: LogsPanelInput): string {
  const c = input.counts;
  const pills = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as LogLevelName[])
    .map((l) => `<span class="pill level-${l}">${l}: ${c.byLevel[l]}</span>`)
    .join(' ');
  const rpath = input.runtimePath ? escapeHtml(input.runtimePath) : '(no workspace)';
  const epath = input.errorPath ? escapeHtml(input.errorPath) : '(no workspace)';
  return `
<div class="box">
  <div class="row"><strong>total:</strong> ${c.total} <span class="muted">(runtime ${c.fromRuntime} / error ${c.fromError})</span> · <span id="shown-count">${c.total}</span> shown</div>
  <div class="row" style="margin-top:4px;">${pills}</div>
  <div class="row muted" style="margin-top:4px;">runtime: <code>${rpath}</code> ${input.runtimeExists ? '' : '<span class="pill err">missing</span>'}</div>
  <div class="row muted">error:&nbsp;&nbsp; <code>${epath}</code> ${input.errorExists ? '' : '<span class="pill err">missing</span>'}</div>
</div>
`;
}

function renderFilterBar(): string {
  return `
<div class="top-bar">
  <button id="btn-refresh">Refresh</button>
  <button class="secondary" id="btn-clear-filters">Clear filters</button>
  <button class="secondary" id="btn-open-runtime">Open runtime.log</button>
  <button class="secondary" id="btn-open-error">Open error.log</button>
  <span style="flex:1;"></span>
  <span class="muted">level:</span>
  ${(['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as LogLevelName[])
    .map((l) => `<label><input type="checkbox" data-level="${l}"/>${l}</label>`)
    .join('')}
  <span class="muted">module:</span>
  <input id="f-module" type="text" placeholder="substring" />
  <span class="muted">keyword:</span>
  <input id="f-keyword" type="text" placeholder="substring" />
</div>
`;
}

function renderTable(entries: readonly LogEntry[]): string {
  if (entries.length === 0) {
    return '<div class="empty">no log entries</div>';
  }
  const rows = entries
    .map((e) => {
      const extra = Object.keys(e.extra).length > 0 ? JSON.stringify(e.extra) : '';
      return `<tr class="log-row log-source-${e.source}">
        <td class="time">${escapeHtml(e.time)}</td>
        <td><span class="level-pill level-${e.level}">${e.level}</span></td>
        <td class="module">${escapeHtml(e.module)}</td>
        <td class="msg">${escapeHtml(e.msg)}</td>
        <td class="extra">${escapeHtml(extra)}</td>
      </tr>`;
    })
    .join('');
  return `
<table class="logs">
  <thead><tr><th>Time</th><th>Lvl</th><th>Module</th><th>Msg</th><th>Extra</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
`;
}

// ─────────── 命令 ───────────

export async function openLogsPanel(
  context: vscode.ExtensionContext,
): Promise<vscode.WebviewPanel> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const panel = vscode.window.createWebviewPanel(
    'dualMind.logsPanel',
    'DualMind · Logs',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    },
  );

  let currentInput: LogsPanelInput | undefined;
  const rerender = async (): Promise<void> => {
    currentInput = await collectLogPanelInput({ workspaceRoot });
    panel.webview.html = buildLogsPanelHtml(currentInput, genPanelNonce(), panel.webview.cspSource);
  };
  await rerender();

  // fs.watch debounce 500ms
  let debounceTimer: NodeJS.Timeout | null = null;
  const scheduleRefresh = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void rerender();
    }, 500);
  };

  const watchers: fsSync.FSWatcher[] = [];
  if (workspaceRoot) {
    const logsDir = path.join(workspaceRoot, '.dualmind', 'logs');
    try {
      await fs.mkdir(logsDir, { recursive: true });
      const w = fsSync.watch(logsDir, { persistent: false }, (_evt, fn) => {
        if (fn === 'runtime.log' || fn === 'error.log') scheduleRefresh();
      });
      watchers.push(w);
    } catch {
      /* no logs dir yet */
    }
  }

  const sub = panel.webview.onDidReceiveMessage(async (msg) => {
    const m = msg as { type?: string; source?: 'runtime' | 'error' } | undefined;
    if (!m || !m.type) return;
    if (m.type === 'refresh') {
      await rerender();
    } else if (m.type === 'openFile') {
      const file = m.source === 'error' ? currentInput?.errorPath : currentInput?.runtimePath;
      if (!file) return;
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
      } catch (e) {
        void vscode.window.showWarningMessage(`打开失败：${(e as Error).message}`);
      }
    }
  });
  panel.onDidDispose(() => {
    sub.dispose();
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* noop */
      }
    }
    if (debounceTimer) clearTimeout(debounceTimer);
  });
  return panel;
}
