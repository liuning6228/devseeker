/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Repo Map —— 代码骨架渲染（纯函数，方案 T1）
 *
 * 从 P2 图索引（GraphIndex）渲染紧凑的「代码骨架摘要」——文件 → 关键符号，
 * 按被调用热度排序。两条投递通道：
 *   - 注入通道：buildSystemPrompt 组装 <repo_map> 块（全局骨架，每 send 一次）
 *   - 工具通道：get_repo_map 工具按需下钻（focus：路径前缀 / 符号 ±1 跳邻接）
 *
 * 设计约束（对齐 docs/repo-map-optimization-plan.md §4/§5）：
 *   - 纯函数、无 I/O、无 vscode 依赖（便于单测 stub；GraphIndex 结构性满足）
 *   - 稳定排序：heat desc → file_path asc → start_line asc（同数据字节级恒等）
 *   - 预算自限：estimateTokens 渐进裁剪（二分钟裁文件数 → 降单文件符号数 → 硬截断）
 *   - 空图 / 无命中 → text undefined（调用方零注入 / 工具侧软提示）
 */

import { estimateTokens } from '../prompts/token-budget.js';
import type { HotSymbolRow, SymbolKind, SymbolRef } from './graph-index.js';

// ─────────── 类型 ───────────

/** 渲染器依赖的只读子集（GraphIndex 结构性满足；测试可 stub） */
export interface RepoMapGraphSource {
  size(): number;
  getHotSymbols(maxNames: number): HotSymbolRow[];
  findSymbolsByPathPrefix(prefix: string, limit: number): SymbolRef[];
  findCallers(symbolName: string, filePath?: string): SymbolRef[];
  findCallees(symbolName: string, filePath?: string): SymbolRef[];
}

export interface RepoMapOptions {
  /** token 预算上限（estimateTokens 估算），默认 1500，clamp [200, 8000] */
  maxTokens?: number;
  /** 热度候选名字上限，默认 300，clamp [20, 1000] */
  maxNames?: number;
  /** 单文件最多展示符号数，默认 4，clamp [1, 10] */
  maxSymbolsPerFile?: number;
  /** focus：目录/文件路径前缀 或 符号名；置位时走局部骨架模式 */
  focus?: string;
}

export interface RepoMapStats {
  /** 展示的文件数 */
  files: number;
  /** 展示的符号数 */
  symbols: number;
  /** 是否因预算发生截断 */
  truncated: boolean;
}

export interface RepoMapResult {
  /** 渲染文本；无数据（空图/无命中）时 undefined（调用方零注入） */
  text?: string;
  stats: RepoMapStats;
}

// ─────────── 常量与工具 ───────────

const ZERO_STATS: RepoMapStats = { files: 0, symbols: 0, truncated: false };

/** focus 符号模式的单方向（callers/callees）展示上限 */
const MAX_FOCUS_REFS = 30;

/** focus 输入长度上限（防超长注入） */
const MAX_FOCUS_CHARS = 300;

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  const n = Math.floor(v);
  return Math.min(max, Math.max(min, n));
}

interface FileGroup {
  filePath: string;
  heat: number;
  symbols: Array<{ name: string; kind: SymbolKind; startLine: number; heat: number }>;
}

/** 按文件聚合热度行；文件与文件内符号均做稳定排序 + 单文件符号数截断 */
function groupByFile(rows: HotSymbolRow[], maxSymbolsPerFile: number): FileGroup[] {
  const byFile = new Map<string, FileGroup>();
  for (const r of rows) {
    let g = byFile.get(r.filePath);
    if (!g) {
      g = { filePath: r.filePath, heat: 0, symbols: [] };
      byFile.set(r.filePath, g);
    }
    g.heat += r.heat;
    g.symbols.push({ name: r.name, kind: r.kind, startLine: r.startLine, heat: r.heat });
  }

  const groups = [...byFile.values()];
  for (const g of groups) {
    g.symbols.sort(
      (a, b) =>
        b.heat - a.heat ||
        a.startLine - b.startLine ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    g.symbols = g.symbols.slice(0, maxSymbolsPerFile);
  }
  groups.sort(
    (a, b) =>
      b.heat - a.heat ||
      (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0),
  );
  return groups;
}

function sumSymbols(groups: FileGroup[]): number {
  let n = 0;
  for (const g of groups) n += g.symbols.length;
  return n;
}

/** 名字 → 最大热度（focus 路径模式为符号附注热度） */
function buildHeatMap(rows: HotSymbolRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    m.set(r.name, Math.max(m.get(r.name) ?? 0, r.heat));
  }
  return m;
}

// ─────────── 渲染 ───────────

/** 全局骨架文本（注入通道 / 工具无 focus 模式） */
function renderGlobalText(groups: FileGroup[], truncated: boolean): string {
  const lines: string[] = [
    '<repo_map>',
    '代码骨架（数据源: 符号调用图索引；按被调用热度排序；文件内为关键符号）',
  ];
  for (const g of groups) {
    lines.push(`${g.filePath}  [heat=${g.heat}]`);
    for (const s of g.symbols) {
      lines.push(`  - ${s.name} (${s.kind}) @${s.startLine}`);
    }
  }
  if (truncated) {
    lines.push(
      `（已截断为 ${groups.length} 文件 / ${sumSymbols(groups)} 符号，优先展示高热度项；完整结构可用 get_repo_map 工具按 focus 定向展开）`,
    );
  }
  lines.push('</repo_map>');
  return lines.join('\n');
}

/** focus 路径模式文本（文件按路径排序，保留目录感） */
function renderFocusPathText(focus: string, groups: FileGroup[], truncated: boolean): string {
  const lines: string[] = [
    '<repo_map>',
    `焦点路径 "${focus}" 的代码骨架（文件 × 关键符号；符号 heat 来自全局调用热度）`,
  ];
  for (const g of groups) {
    lines.push(g.filePath);
    for (const s of g.symbols) {
      lines.push(`  - ${s.name} (${s.kind}) @${s.startLine}${s.heat > 0 ? ` [heat=${s.heat}]` : ''}`);
    }
  }
  if (truncated) {
    lines.push(
      `（已截断为 ${groups.length} 文件 / ${sumSymbols(groups)} 符号；可用更具体的 focus 前缀缩小范围）`,
    );
  }
  lines.push('</repo_map>');
  return lines.join('\n');
}

/** 硬截断兜底：循环收窄至预算内（去重闭合标签，避免重复追加） */
function hardTruncate(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  // 剥离尾部闭合标签后按字符滑窗截断（渲染器 maxTokens ≥ 200，
  // 64 字符下限必然满足预算，循环必收敛）
  const body = text.replace(/<\/repo_map>\s*$/, '');
  let maxChars = Math.max(200, maxTokens * 4);
  let out = `${body.slice(0, maxChars)}\n…（截断）\n</repo_map>`;
  while (estimateTokens(out) > maxTokens && maxChars > 64) {
    maxChars = Math.floor(maxChars * 0.6);
    out = `${body.slice(0, maxChars)}\n…（截断）\n</repo_map>`;
  }
  return out;
}

/**
 * 预算渐进裁剪：
 *   1. 全量渲染 → 满足即返回（truncated=false）
 *   2. 二分找最大可展示文件前缀（丢低热度尾部文件）→ truncated=true
 *   3. 单文件仍超 → 逐减单文件符号数
 *   4. 仍超 → 硬截断
 * render 回调接受 (可见分组, 是否截断) 返回完整文本。
 */
function renderWithBudget(
  groups: FileGroup[],
  render: (visible: FileGroup[], truncated: boolean) => string,
  maxTokens: number,
): RepoMapResult {
  // 阶段 1：全量
  const fullText = render(groups, false);
  if (estimateTokens(fullText) <= maxTokens) {
    return {
      text: fullText,
      stats: { files: groups.length, symbols: sumSymbols(groups), truncated: false },
    };
  }

  // 阶段 2：二分最大文件前缀（前提：单文件可满足预算）
  if (groups.length > 1 && estimateTokens(render(groups.slice(0, 1), true)) <= maxTokens) {
    let lo = 1;
    let hi = groups.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateTokens(render(groups.slice(0, mid), true)) <= maxTokens) lo = mid;
      else hi = mid - 1;
    }
    const shown = groups.slice(0, lo);
    return {
      text: render(shown, true),
      stats: { files: lo, symbols: sumSymbols(shown), truncated: true },
    };
  }

  // 阶段 3：单文件降符号数
  const first = groups[0];
  if (first && first.symbols.length > 1) {
    for (let s = first.symbols.length - 1; s >= 1; s--) {
      const candidate: FileGroup[] = [{ ...first, symbols: first.symbols.slice(0, s) }];
      const text = render(candidate, true);
      if (estimateTokens(text) <= maxTokens) {
        return { text, stats: { files: 1, symbols: s, truncated: true } };
      }
    }
  }

  // 阶段 4：硬截断
  const minimal: FileGroup[] = first
    ? [{ ...first, symbols: first.symbols.slice(0, 1) }]
    : [];
  const text = hardTruncate(render(minimal, true), maxTokens);
  return {
    text,
    stats: { files: minimal.length, symbols: sumSymbols(minimal), truncated: true },
  };
}

// ─────────── 主入口 ───────────

/**
 * 渲染 Repo Map。
 *
 * - 空图 / 无命中 → `{ stats: 全零 }`（无 text）
 * - opts.focus 置位 → 局部骨架（路径前缀 / 符号 ±1 跳）
 * - 内部异常一律软失败（返回全零 stats，绝不抛出）
 */
export function buildRepoMap(
  graph: RepoMapGraphSource | undefined,
  opts: RepoMapOptions = {},
): RepoMapResult {
  if (!graph || graph.size() <= 0) return { stats: ZERO_STATS };

  const maxTokens = clampInt(opts.maxTokens, 200, 8000, 1500);
  const maxNames = clampInt(opts.maxNames, 20, 1000, 300);
  const maxSymbolsPerFile = clampInt(opts.maxSymbolsPerFile, 1, 10, 4);
  const focus = (opts.focus ?? '').trim().slice(0, MAX_FOCUS_CHARS);

  try {
    if (focus) {
      return buildFocus(graph, focus, { maxTokens, maxNames, maxSymbolsPerFile });
    }
    return buildGlobal(graph, { maxTokens, maxNames, maxSymbolsPerFile });
  } catch {
    return { stats: ZERO_STATS };
  }
}

/** 语义化封装：focus 模式（get_repo_map 工具 focus 参数 / 定向下钻） */
export function buildRepoMapFocus(
  graph: RepoMapGraphSource | undefined,
  focus: string,
  opts: Omit<RepoMapOptions, 'focus'> = {},
): RepoMapResult {
  return buildRepoMap(graph, { ...opts, focus });
}

interface ResolvedOptions {
  maxTokens: number;
  maxNames: number;
  maxSymbolsPerFile: number;
}

function buildGlobal(graph: RepoMapGraphSource, o: ResolvedOptions): RepoMapResult {
  const hot = graph.getHotSymbols(o.maxNames);
  if (hot.length === 0) return { stats: ZERO_STATS };
  const groups = groupByFile(hot, o.maxSymbolsPerFile);
  return renderWithBudget(groups, renderGlobalText, o.maxTokens);
}

function buildFocus(graph: RepoMapGraphSource, focus: string, o: ResolvedOptions): RepoMapResult {
  // 路径模式判定：含路径分隔符 或 带文件扩展名 → 走路径前缀查询
  const isPathLike = focus.includes('/') || /\.[A-Za-z0-9]+$/.test(focus);

  if (isPathLike) {
    // 500 = 查询接口上限：大目录 focus 时降低“路径序截断”漏掉高热度文件的风险
    const refs = graph.findSymbolsByPathPrefix(focus, 500);
    if (refs.length === 0) return { stats: ZERO_STATS };
    const heatMap = buildHeatMap(graph.getHotSymbols(o.maxNames));
    const rows: HotSymbolRow[] = refs.map((r) => ({
      name: r.name,
      kind: r.kind,
      filePath: r.filePath,
      startLine: r.startLine,
      endLine: r.endLine,
      heat: heatMap.get(r.name) ?? 0,
    }));
    const groups = groupByFile(rows, o.maxSymbolsPerFile);
    // focus 路径模式：文件顺序改按路径 asc（保留目录感），符号顺序仍按热度
    groups.sort((a, b) =>
      a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0,
    );
    return renderWithBudget(
      groups,
      (visible, truncated) => renderFocusPathText(focus, visible, truncated),
      o.maxTokens,
    );
  }

  // 符号模式：±1 跳邻接骨架
  const callers = graph.findCallers(focus).filter((r) => r.filePath !== '<external>');
  const callees = graph.findCallees(focus).filter((r) => r.filePath !== '<external>');
  if (callers.length === 0 && callees.length === 0) return { stats: ZERO_STATS };

  const lines: string[] = [
    '<repo_map>',
    `焦点符号 "${focus}" 的局部调用骨架（±1 跳）`,
  ];
  if (callers.length > 0) {
    lines.push('callers（调用了它的定义）:');
    for (const c of callers.slice(0, MAX_FOCUS_REFS)) {
      lines.push(`  - ${c.name} (${c.kind}) @ ${c.filePath}:${c.startLine}`);
    }
  }
  if (callees.length > 0) {
    lines.push('callees（它调用的定义）:');
    for (const c of callees.slice(0, MAX_FOCUS_REFS)) {
      lines.push(`  - ${c.name} (${c.kind}) @ ${c.filePath}:${c.startLine}`);
    }
  }
  lines.push('</repo_map>');

  const text = hardTruncate(lines.join('\n'), o.maxTokens);
  const all = new Set<string>();
  for (const r of [...callers, ...callees]) all.add(r.filePath);
  return {
    text,
    stats: {
      files: all.size,
      symbols: Math.min(callers.length, MAX_FOCUS_REFS) + Math.min(callees.length, MAX_FOCUS_REFS),
      truncated:
        callers.length > MAX_FOCUS_REFS ||
        callees.length > MAX_FOCUS_REFS ||
        text.includes('…（截断）'),
    },
  };
}
