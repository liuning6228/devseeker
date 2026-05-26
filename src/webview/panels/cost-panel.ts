/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * C2 · Cost Panel UI（B-P1-6）
 *
 * 面板展示：
 *   1. 顶部 KPI：session / today / total 三列（CNY + USD）+ cache hit rate
 *   2. Top-N Providers 表（按 session cost desc）
 *   3. 近 30 天成本 sparkline（内联 SVG，基于 ~/.dualmind/usage.jsonl）
 *   4. 最近 50 条 usage 记录表（ts / provider / op / tokens / cost）
 *
 * 数据源：
 *   - `getPanel()` 回调拿 DualMindChatPanel 的 CostSummaryPayload（含 session/total/today/byProvider）
 *   - 历史：由调用方注入 `UsageReadStore`（SqliteUsageStore / UsageJsonlStore 均实现）
 *
 * 拆分：
 *   - `buildCostPanelHtml(input, nonce, cspSource)` 纯函数
 *   - `aggregateDailySeries(records, days)` 纯函数（可单测 UTC 分桶）
 *   - `computeCacheHitRate(byProvider)` 纯函数
 *   - `openCostPanel(context, getSummary, getUsageStore)` 注册命令
 */

import * as vscode from 'vscode';
import type { IUsageRecord } from '../../core/cost/types.js';
import type { CostSummaryPayload } from '../../shared/protocol.js';
import {
  renderBaseHtml,
  genPanelNonce,
  escapeHtml,
  formatNumber,
} from './base.js';

/**
 * Cost 面板只读依赖：任何满足「readAll + getFilePath」的 store 都能注入。
 * 现有实现：SqliteUsageStore（SQLite 时代），UsageJsonlStore（遗留 JSONL，已废弃）。
 */
export interface UsageReadStore {
  readAll(): Promise<IUsageRecord[]>;
  getFilePath(): string;
}

// ─────────── 数据层 ───────────

export interface CostPanelInput {
  summary: CostSummaryPayload | undefined;
  /** 历史分组：按日（UTC）聚合；array[0] 是最早、array[-1] 是今天 */
  dailySeries: DailyCostPoint[];
  /** 最近 N 条原始记录（已按 ts desc） */
  recentRecords: RecentRecord[];
  /** 总记录条数 */
  totalRecords: number;
  /** 当前 usage.jsonl 路径（调试用） */
  usageFilePath: string;
  /** cache 命中率：cached / prompt（未命中 provider 时为 undefined） */
  cacheHitRate: number | undefined;
  warnings: string[];
  generatedAt: string;
}

export interface DailyCostPoint {
  /** YYYY-MM-DD（本地日期，便于展示） */
  date: string;
  costCNY: number;
  costUSD: number;
  calls: number;
  promptTokens: number;
  cachedTokens: number;
}

export interface RecentRecord {
  ts: number;
  provider: string;
  operation: string;
  model?: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  cost: number;
  currency: 'CNY' | 'USD';
}

/** 采集数据（含历史 + 当前 summary） */
export async function collectCostPanelInput(opts: {
  summary: CostSummaryPayload | undefined;
  usageStore: UsageReadStore;
  days?: number;
  recentLimit?: number;
}): Promise<CostPanelInput> {
  const days = opts.days ?? 30;
  const recentLimit = opts.recentLimit ?? 50;
  const store = opts.usageStore;
  const warnings: string[] = [];

  let records: IUsageRecord[] = [];
  try {
    records = await store.readAll();
  } catch (e) {
    warnings.push(`usage-store: ${(e as Error).message}`);
  }

  const dailySeries = aggregateDailySeries(records, days, Date.now());
  const recentRecords = records
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, recentLimit)
    .map(toRecentRecord);

  return {
    summary: opts.summary,
    dailySeries,
    recentRecords,
    totalRecords: records.length,
    usageFilePath: store.getFilePath(),
    cacheHitRate: computeCacheHitRate(opts.summary?.byProvider),
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

function toRecentRecord(r: IUsageRecord): RecentRecord {
  return {
    ts: r.ts,
    provider: r.provider,
    operation: r.operation,
    ...(r.model !== undefined ? { model: r.model } : {}),
    promptTokens: r.promptTokens ?? 0,
    cachedTokens: r.cachedTokens ?? 0,
    completionTokens: r.completionTokens ?? 0,
    cost: r.cost,
    currency: r.currency,
  };
}

/**
 * 按「本地日期」分桶，产出连续 N 天（含今天）的序列。
 * 空桶也保留（0 成本），便于 sparkline 画等距点。
 *
 * @param records 全量记录（任意顺序）
 * @param days 桶个数（最近 N 天，含今天）
 * @param nowMs 当前时间（便于单测可控）
 */
export function aggregateDailySeries(
  records: readonly IUsageRecord[],
  days: number,
  nowMs: number,
): DailyCostPoint[] {
  if (days <= 0) return [];
  // 以本地日开始（00:00:00）为桶边界
  const dayStarts: number[] = [];
  const dayKeys: string[] = [];
  const now = new Date(nowMs);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (let i = days - 1; i >= 0; i--) {
    const t = today - i * 24 * 3600_000;
    dayStarts.push(t);
    dayKeys.push(formatLocalDate(new Date(t)));
  }
  const buckets: DailyCostPoint[] = dayKeys.map((d) => ({
    date: d,
    costCNY: 0,
    costUSD: 0,
    calls: 0,
    promptTokens: 0,
    cachedTokens: 0,
  }));
  for (const r of records) {
    const idx = findBucketIdx(r.ts, dayStarts);
    if (idx < 0) continue;
    const b = buckets[idx]!;
    if (r.currency === 'CNY') b.costCNY += r.cost;
    else b.costUSD += r.cost;
    b.calls += 1;
    b.promptTokens += r.promptTokens ?? 0;
    b.cachedTokens += r.cachedTokens ?? 0;
  }
  // 四舍五入保持展示整洁
  for (const b of buckets) {
    b.costCNY = round6(b.costCNY);
    b.costUSD = round6(b.costUSD);
  }
  return buckets;
}

function findBucketIdx(ts: number, dayStarts: number[]): number {
  if (ts < dayStarts[0]!) return -1;
  // dayStarts 升序；找到最后一个 <= ts 的下标
  let lo = 0;
  let hi = dayStarts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dayStarts[mid]! <= ts) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** cache 命中率：sum(cached) / sum(prompt)；无数据返回 undefined */
export function computeCacheHitRate(
  byProvider: CostSummaryPayload['byProvider'] | undefined,
): number | undefined {
  if (!byProvider || byProvider.length === 0) return undefined;
  let cached = 0;
  let prompt = 0;
  for (const p of byProvider) {
    cached += p.cachedTokens;
    prompt += p.promptTokens;
  }
  if (prompt <= 0) return undefined;
  return cached / prompt;
}

// ─────────── HTML 渲染 ───────────

const STYLE = `
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; padding: 12px; }
.kpi { border: 1px solid var(--border); padding: 10px; border-radius: 4px; }
.kpi .lbl { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.kpi .v { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.kpi .sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
section { padding: 12px; border-bottom: 1px solid var(--border); }
.spark { background: rgba(128,128,128,0.06); border: 1px solid var(--border); border-radius: 4px; padding: 8px; }
.spark svg { display: block; width: 100%; height: 80px; }
.spark-axis { display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); margin-top: 4px; }
table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.empty-note { color: var(--muted); font-size: 11px; font-style: italic; }
code.path { font-size: 11px; word-break: break-all; }
`;

const SCRIPT = `
const btn = document.getElementById('refreshBtn');
if (btn) btn.addEventListener('click', () => window.__vscode.postMessage({ type: 'refresh' }));
`;

export function buildCostPanelHtml(
  input: CostPanelInput,
  nonce: string,
  cspSource: string,
): string {
  return renderBaseHtml({
    title: 'DualMind · Cost',
    nonce,
    cspSource,
    style: STYLE,
    script: SCRIPT,
    body: renderBody(input),
  });
}

function renderBody(input: CostPanelInput): string {
  const ts = new Date(input.generatedAt).toLocaleString();
  return `
<h1>DualMind · Cost <span class="muted" style="font-weight:normal;margin-left:8px;">${escapeHtml(ts)}</span>
  <span style="float:right;"><button id="refreshBtn">Refresh</button></span>
</h1>

${renderWarnings(input.warnings)}

${renderKpis(input)}

${renderTopProviders(input.summary?.byProvider ?? [])}

${renderSparkline(input.dailySeries)}

${renderRecent(input.recentRecords, input.totalRecords)}

<section>
  <h2>Usage File</h2>
  <code class="path">${escapeHtml(input.usageFilePath)}</code>
  <div class="muted" style="font-size:11px;margin-top:4px;">total records: ${input.totalRecords}</div>
</section>
`;
}

function renderKpis(input: CostPanelInput): string {
  const s = input.summary?.session;
  const t = input.summary?.total;
  const today = input.summary?.today;
  const hitRate = input.cacheHitRate;
  const pct = hitRate === undefined ? 'n/a' : `${Math.round(hitRate * 100)}%`;
  const hitPill = hitRate === undefined ? '' : hitRate >= 0.6 ? 'ok' : 'warn';

  return `
<section>
  <h2>Overview</h2>
  <div class="kpis">
    ${kpi('Session', fmtMoney(s?.CNY, s?.USD), `${s?.calls ?? 0} calls · ${formatNumber(s?.promptTokens ?? 0, 0)} prompt tokens`)}
    ${kpi('Today', fmtMoney(today?.CNY, today?.USD), '')}
    ${kpi('All Time', fmtMoney(t?.CNY, t?.USD), `${t?.calls ?? 0} calls`)}
    ${kpi(
      'Cache Hit',
      `<span class="pill ${hitPill}">${pct}</span>`,
      hitRate === undefined ? '(no prompt tokens yet)' : 'cached / prompt',
    )}
  </div>
</section>`;
}

function kpi(lbl: string, v: string, sub: string): string {
  return `<div class="kpi">
    <div class="lbl">${escapeHtml(lbl)}</div>
    <div class="v">${v}</div>
    ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
  </div>`;
}

function fmtMoney(cny: number | undefined, usd: number | undefined): string {
  const parts: string[] = [];
  if (cny !== undefined && cny > 0) parts.push(`¥${formatNumber(cny, 4)}`);
  if (usd !== undefined && usd > 0) parts.push(`$${formatNumber(usd, 4)}`);
  return parts.length ? parts.join(' + ') : '<span class="muted">—</span>';
}

function renderTopProviders(byProvider: CostSummaryPayload['byProvider']): string {
  if (byProvider.length === 0) {
    return `<section><h2>Top Providers</h2><div class="empty-note">(no provider usage yet in current session)</div></section>`;
  }
  const sorted = byProvider.slice().sort((a, b) => b.cost - a.cost).slice(0, 5);
  const rows = sorted
    .map((p) => {
      const hit =
        p.promptTokens > 0 ? `${Math.round((p.cachedTokens / p.promptTokens) * 100)}%` : '-';
      return `<tr>
        <td>${escapeHtml(p.providerId)}</td>
        <td><span class="pill">${escapeHtml(p.currency)}</span></td>
        <td class="num">${formatNumber(p.cost, 6)}</td>
        <td class="num">${p.calls}</td>
        <td class="num">${formatNumber(p.promptTokens, 0)}</td>
        <td class="num">${formatNumber(p.completionTokens, 0)}</td>
        <td class="num">${formatNumber(p.cachedTokens, 0)}</td>
        <td class="num">${escapeHtml(hit)}</td>
      </tr>`;
    })
    .join('');
  return `
<section>
  <h2>Top ${sorted.length} Providers (session)</h2>
  <table>
    <thead><tr><th>Provider</th><th>Ccy</th><th>Cost</th><th>Calls</th><th>Prompt</th><th>Completion</th><th>Cached</th><th>Cache%</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderSparkline(series: readonly DailyCostPoint[]): string {
  if (series.length === 0) {
    return `<section><h2>Daily Cost (last 30d)</h2><div class="empty-note">(no history)</div></section>`;
  }
  // 将 CNY + USD 粗暴相加仅为绘图（币种提示放图下方）
  const totals = series.map((p) => p.costCNY + p.costUSD);
  const max = Math.max(...totals, 1e-9);
  const w = 600;
  const h = 60;
  const stepX = series.length > 1 ? w / (series.length - 1) : w;
  const points = totals
    .map((v, i) => {
      const x = +(i * stepX).toFixed(2);
      const y = +(h - (v / max) * h).toFixed(2);
      return `${x},${y}`;
    })
    .join(' ');
  const maxCNY = Math.max(...series.map((p) => p.costCNY));
  const maxUSD = Math.max(...series.map((p) => p.costUSD));
  const firstDay = series[0]!.date;
  const lastDay = series[series.length - 1]!.date;

  return `
<section>
  <h2>Daily Cost (last ${series.length}d)</h2>
  <div class="spark">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <polyline
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        points="${points}"
      />
    </svg>
    <div class="spark-axis">
      <span>${escapeHtml(firstDay)}</span>
      <span class="muted">peak · CNY ${formatNumber(maxCNY, 4)} / USD ${formatNumber(maxUSD, 4)}</span>
      <span>${escapeHtml(lastDay)}</span>
    </div>
  </div>
</section>`;
}

function renderRecent(records: readonly RecentRecord[], total: number): string {
  if (records.length === 0) {
    return `<section><h2>Recent Usage</h2><div class="empty-note">(no records in ~/.dualmind/usage.jsonl)</div></section>`;
  }
  const rows = records
    .map(
      (r) => `<tr>
      <td>${escapeHtml(new Date(r.ts).toLocaleString())}</td>
      <td>${escapeHtml(r.provider)}</td>
      <td><span class="pill">${escapeHtml(r.operation)}</span></td>
      <td>${escapeHtml(r.model ?? '-')}</td>
      <td class="num">${formatNumber(r.promptTokens, 0)}</td>
      <td class="num">${formatNumber(r.cachedTokens, 0)}</td>
      <td class="num">${formatNumber(r.completionTokens, 0)}</td>
      <td class="num">${formatNumber(r.cost, 6)} ${escapeHtml(r.currency)}</td>
    </tr>`,
    )
    .join('');
  const overflow =
    total > records.length
      ? `<div class="muted" style="font-size:11px;margin-top:4px;">(showing ${records.length} of ${total})</div>`
      : '';
  return `
<section>
  <h2>Recent Usage</h2>
  <table>
    <thead><tr><th>Time</th><th>Provider</th><th>Op</th><th>Model</th><th>Prompt</th><th>Cached</th><th>Compl</th><th>Cost</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${overflow}
</section>`;
}

function renderWarnings(warnings: readonly string[]): string {
  if (warnings.length === 0) return '';
  const items = warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  return `<section style="color:var(--warn);"><h2>Warnings</h2><ul>${items}</ul></section>`;
}

// ─────────── 命令胶水 ───────────

export async function openCostPanel(
  context: vscode.ExtensionContext,
  getSummary: () => CostSummaryPayload | undefined,
  getUsageStore: () => UsageReadStore | undefined,
): Promise<vscode.WebviewPanel> {
  const panel = vscode.window.createWebviewPanel(
    'dualMind.costPanel',
    'DualMind · Cost',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    },
  );

  const rerender = async (): Promise<void> => {
    const store = getUsageStore();
    if (!store) {
      // 未激活（聊天面板未打开），给空数据 + 提示
      panel.webview.html = buildCostPanelHtml(
        {
          summary: getSummary(),
          dailySeries: [],
          recentRecords: [],
          totalRecords: 0,
          usageFilePath: '(usage store unavailable: open chat panel first)',
          cacheHitRate: undefined,
          warnings: ['usage store not ready — open DualMind chat panel to initialize SQLite store'],
          generatedAt: new Date().toISOString(),
        },
        genPanelNonce(),
        panel.webview.cspSource,
      );
      return;
    }
    const input = await collectCostPanelInput({ summary: getSummary(), usageStore: store });
    panel.webview.html = buildCostPanelHtml(input, genPanelNonce(), panel.webview.cspSource);
  };

  await rerender();
  const sub = panel.webview.onDidReceiveMessage((msg) => {
    if ((msg as { type?: string } | undefined)?.type === 'refresh') {
      void rerender();
    }
  });
  panel.onDidDispose(() => sub.dispose());
  return panel;
}
