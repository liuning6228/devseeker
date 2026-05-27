/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * FrameworkContext（DESIGN §M10.1 · B-P1-13）
 *
 * Claude Code / Cursor / Cline 共同的「框架自动注入 4 块」在本实现中归为五块：
 *   1. `<current_open_file>`  当前编辑器焦点文件（总是注入）
 *   2. `<open_tabs>`           当前编辑器打开的标签列表（最多 30 条）
 *   3. `<workspace_tree>`     首轮注入的工作区目录树快照（≤100 行；排除 node_modules/.git/dist/build）
 *   4. `<git_status>`         工作区有 .git 时注入（porcelain short）
 *   5. `<git_diff_staged>`    仅 Debug mode 且 staged 非空时注入
 *
 * 设计原则：
 * 1. **可测试**：所有 IO 通过 DI，纯函数易于 stub。
 * 2. **稳定排序**：字段顺序固定，同输入字节级恒等输出。
 * 3. **轻量注入**：仅出现在 L3 层，不影响 L0/L1/L2 前缀缓存。
 * 4. **一次性目录树**：`isFirstTurn=true` 才输出 workspace_tree；后续由
 *    panel 用 workspaceState 键 `devSeeker.hasEmittedWorkspaceTree` 控制。
 * 5. **Debug 独占 staged**：避免 Ask/Agent 常规对话被 diff 噪音淹没。
 *
 * 与 git-context（B-P1-11）的分工：
 *   - git-context 采集 branch/HEAD/recent commits/staged file list
 *   - 本模块采集 git status（porcelain）+ diff --cached（仅 Debug）
 *   两者互补，不重复。
 */

import type { Mode } from '../modes/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenTabInfo {
  /** 相对工作区根的路径（斜杠分隔） */
  path: string;
  /** 是否为当前激活 tab（可选，用于标注） */
  active?: boolean;
  /** 是否有未保存修改（可选） */
  dirty?: boolean;
}

export interface FrameworkContextSnapshot {
  /** 当前激活编辑器的相对路径；无激活文件时为 undefined */
  currentOpenFile?: string;
  /** 当前编辑器所有 tab（上限 30，已截断） */
  openTabs: readonly OpenTabInfo[];
  /** 工作区目录树（仅 firstTurn=true 时非空；已截断 ≤100 行） */
  workspaceTree?: string;
  /** `git status --porcelain=v1` 输出；无 .git 时 undefined */
  gitStatus?: string;
  /** `git diff --cached --stat` 输出；仅 Debug 且 staged 非空时 undefined 否则为非空字符串 */
  gitDiffStaged?: string;
}

export interface FrameworkContextCollectOptions {
  /** 当前 Mode，用于判断是否注入 git_diff_staged（仅 Debug） */
  mode: Mode;
  /** 是否是会话首轮；仅首轮注入 workspace_tree */
  isFirstTurn: boolean;
  /** 工作区根目录；无工作区时上述所有块均不生成 */
  workspaceRoot?: string;

  /** DI · 获取当前激活编辑器的相对路径 */
  getActiveFile?: () => string | undefined;
  /** DI · 获取全部打开 tab 的清单 */
  getOpenTabs?: () => readonly OpenTabInfo[];
  /** DI · 采集工作区目录树，返回原始多行文本；调用方自行 findFiles；本模块再截断/过滤 */
  getWorkspaceTree?: () => Promise<string | undefined> | string | undefined;
  /** DI · 返回 git status porcelain 原文；无 .git 或失败时返回 undefined */
  getGitStatus?: () => Promise<string | undefined> | string | undefined;
  /** DI · 返回 git diff --cached --stat 原文；无 staged 或失败时返回 undefined */
  getGitDiffStaged?: () => Promise<string | undefined> | string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_OPEN_TABS = 30;
export const MAX_WORKSPACE_TREE_LINES = 100;
/** workspaceTree 过滤的目录（不区分大小写；按相对路径前缀匹配） */
export const WORKSPACE_TREE_EXCLUDES: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.vscode-test',
  'coverage',
];

// ─────────────────────────────────────────────────────────────────────────────
// Collect
// ─────────────────────────────────────────────────────────────────────────────

/** 采集快照；不做 IO，所有数据由 DI 回调提供。 */
export async function collectFrameworkContext(
  opts: FrameworkContextCollectOptions,
): Promise<FrameworkContextSnapshot> {
  if (!opts.workspaceRoot) {
    return { openTabs: [] };
  }

  const currentOpenFile = opts.getActiveFile?.();
  const rawTabs = opts.getOpenTabs?.() ?? [];
  const openTabs = rawTabs.slice(0, MAX_OPEN_TABS);

  let workspaceTree: string | undefined;
  if (opts.isFirstTurn && opts.getWorkspaceTree) {
    try {
      const raw = await Promise.resolve(opts.getWorkspaceTree());
      workspaceTree = normalizeWorkspaceTree(raw);
    } catch {
      workspaceTree = undefined;
    }
  }

  let gitStatus: string | undefined;
  if (opts.getGitStatus) {
    try {
      const raw = await Promise.resolve(opts.getGitStatus());
      // 不能 trim 开头空格（' M src/a.ts' 的剩下字段宽度依赖）。
      // 只剔掉尾部空白以保持输出整洁。
      const trimmed = typeof raw === 'string' ? raw.replace(/\s+$/u, '') : '';
      gitStatus = trimmed.length > 0 ? trimmed : undefined;
    } catch {
      gitStatus = undefined;
    }
  }

  let gitDiffStaged: string | undefined;
  if (opts.mode === 'debug' && opts.getGitDiffStaged) {
    try {
      const raw = await Promise.resolve(opts.getGitDiffStaged());
      const trimmed = typeof raw === 'string' ? raw.replace(/\s+$/u, '') : '';
      gitDiffStaged = trimmed.length > 0 ? trimmed : undefined;
    } catch {
      gitDiffStaged = undefined;
    }
  }

  const snap: FrameworkContextSnapshot = { openTabs };
  if (currentOpenFile) snap.currentOpenFile = currentOpenFile;
  if (workspaceTree) snap.workspaceTree = workspaceTree;
  if (gitStatus) snap.gitStatus = gitStatus;
  if (gitDiffStaged) snap.gitDiffStaged = gitDiffStaged;
  return snap;
}

/** 过滤、去重、截断 workspaceTree 多行文本。返回 undefined 表示无内容可写。 */
function normalizeWorkspaceTree(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // 归一化斜杠以便做前缀匹配
    const norm = line.replace(/\\/g, '/');
    if (WORKSPACE_TREE_EXCLUDES.some((d) => norm === d || norm.startsWith(`${d}/`))) {
      continue;
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    lines.push(norm);
    if (lines.length >= MAX_WORKSPACE_TREE_LINES) break;
  }
  if (lines.length === 0) return undefined;
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Format
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把快照格式化为多段 XML-like 文本；若所有块均为空返回空字符串。
 *
 * 输出顺序固定：current_open_file → open_tabs → workspace_tree → git_status → git_diff_staged。
 * 各块之间用单个空行分隔，便于模型解析且字节级稳定。
 */
export function formatFrameworkContext(snapshot: FrameworkContextSnapshot): string {
  const blocks: string[] = [];

  if (snapshot.currentOpenFile) {
    blocks.push(`<current_open_file>\n${snapshot.currentOpenFile}\n</current_open_file>`);
  }

  if (snapshot.openTabs.length > 0) {
    const tabLines: string[] = ['<open_tabs>'];
    for (const t of snapshot.openTabs) {
      const marks: string[] = [];
      if (t.active) marks.push('active');
      if (t.dirty) marks.push('dirty');
      const suffix = marks.length > 0 ? ` (${marks.join(',')})` : '';
      tabLines.push(`${t.path}${suffix}`);
    }
    tabLines.push('</open_tabs>');
    blocks.push(tabLines.join('\n'));
  }

  if (snapshot.workspaceTree) {
    blocks.push(`<workspace_tree>\n${snapshot.workspaceTree}\n</workspace_tree>`);
  }

  if (snapshot.gitStatus) {
    blocks.push(`<git_status>\n${snapshot.gitStatus}\n</git_status>`);
  }

  if (snapshot.gitDiffStaged) {
    blocks.push(`<git_diff_staged>\n${snapshot.gitDiffStaged}\n</git_diff_staged>`);
  }

  return blocks.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

/** 便捷组合：采集 + 格式化。返回空字符串表示无可注入内容。 */
export async function buildFrameworkContext(
  opts: FrameworkContextCollectOptions,
): Promise<string> {
  const snap = await collectFrameworkContext(opts);
  return formatFrameworkContext(snap);
}
