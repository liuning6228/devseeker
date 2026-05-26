/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 代码库文件扫描器（W3 批次 1）
 *
 * 职责：
 * - 递归扫描工作区，返回可索引的源码文件路径（相对工作区根）
 * - 默认忽略噪声目录（node_modules / .git / dist / out …）
 * - 扩展名白名单过滤
 * - 单文件尺寸上限（避免 OOM）
 *
 * 约束：
 * - 不跟随 symlink 出工作区
 * - 所有路径返回 POSIX 风格（'/' 分隔），便于跨平台比较
 */

import { promises as fs } from 'node:fs';
import { resolve as resolvePath, join, relative, sep as pathSep } from 'node:path';

/** 默认忽略目录（与 list_dir 保持一致 + 索引专属） */
const DEFAULT_IGNORE_DIRS = new Set<string>([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'coverage',
  '.nyc_output',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.vscode-test',
  '.dualmind', // 自身工作产物
  '.idea',
  '.DS_Store',
]);

/** 默认扩展名白名单（源码 + 常见文档） */
export const DEFAULT_INCLUDE_EXT = new Set<string>([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cc',
  '.cs',
  '.swift',
  '.m',
  '.mm',
  '.rb',
  '.php',
  '.scala',
  '.lua',
  '.dart',
  '.vue',
  '.svelte',
  '.html',
  '.css',
  '.scss',
  '.less',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.md',
  '.sh',
  '.ps1',
]);

/** 默认单文件尺寸上限（字节） */
export const DEFAULT_MAX_FILE_SIZE = 512 * 1024; // 512 KB

export interface ScannerOptions {
  /** 覆盖默认忽略目录（完全替换）。未传使用内置列表。 */
  ignoreDirs?: Set<string>;
  /** 追加忽略目录（与默认合并）。 */
  extraIgnoreDirs?: Iterable<string>;
  /** 覆盖扩展名白名单（完全替换）。未传使用内置列表。 */
  includeExt?: Set<string>;
  /** 追加扩展名白名单。 */
  extraIncludeExt?: Iterable<string>;
  /** 单文件尺寸上限（字节）。 */
  maxFileSize?: number;
  /** 返回文件数量上限（防爆）。 */
  maxFiles?: number;
}

export interface ScannedFile {
  /** 工作区相对路径，POSIX 分隔符 */
  relPath: string;
  /** 文件绝对路径 */
  absPath: string;
  /** 文件字节数 */
  size: number;
  /** 文件 mtime（ms since epoch） */
  mtimeMs: number;
}

/** B-1.0.1-C · 被过滤条目采样（用于诊断扫到 0 files 的真因）。 */
export interface FilterSample {
  /** 工作区相对路径（POSIX） */
  relPath: string;
  /** 被过滤原因 */
  reason: 'ignored-dir' | 'ext-not-whitelisted' | 'too-large';
  /** 可选补充：扩展名或字节数 */
  detail?: string;
}

/** 最多采样条数（总量封顶，防爆内存） */
const FILTER_SAMPLE_CAP = 10;

export interface ScanResult {
  files: ScannedFile[];
  /** 被跳过的大文件数 */
  skippedLarge: number;
  /** 被跳过的扩展名不匹配数 */
  skippedExt: number;
  /** B-1.0.1-C · 前 N 条被过滤样本（供 0 files 诊断）；空数组 = 无样本 */
  filterSamples: FilterSample[];
}

/**
 * 扫描工作区。
 */
export async function scanWorkspace(
  workspaceRoot: string,
  options: ScannerOptions = {},
): Promise<ScanResult> {
  const ignoreDirs = new Set(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
  if (options.extraIgnoreDirs) {
    for (const d of options.extraIgnoreDirs) ignoreDirs.add(d);
  }
  const includeExt = new Set(options.includeExt ?? DEFAULT_INCLUDE_EXT);
  if (options.extraIncludeExt) {
    for (const e of options.extraIncludeExt) includeExt.add(e);
  }
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const maxFiles = options.maxFiles ?? 10_000;

  const rootAbs = resolvePath(workspaceRoot);
  const files: ScannedFile[] = [];
  let skippedLarge = 0;
  let skippedExt = 0;
  const filterSamples: FilterSample[] = [];

  // B-1.0.1-C · 采样：每类原因最多 4 条，总量 10 条封顶
  const perReasonCap = 4;
  const perReasonCount = new Map<FilterSample['reason'], number>();
  function sampleFilter(relPath: string, reason: FilterSample['reason'], detail?: string): void {
    if (filterSamples.length >= FILTER_SAMPLE_CAP) return;
    const cnt = perReasonCount.get(reason) ?? 0;
    if (cnt >= perReasonCap) return;
    perReasonCount.set(reason, cnt + 1);
    filterSamples.push(detail ? { relPath, reason, detail } : { relPath, reason });
  }

  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const name = entry.name;
      if (name === '.' || name === '..') continue;

      const abs = join(dir, name);

      if (entry.isDirectory()) {
        if (ignoreDirs.has(name)) {
          sampleFilter(toPosix(relative(rootAbs, abs)), 'ignored-dir', name);
          continue;
        }
        // 避免跟随 symlink 出工作区
        if (entry.isSymbolicLink?.()) {
          try {
            const real = await fs.realpath(abs);
            if (!isInside(real, rootAbs)) continue;
          } catch {
            continue;
          }
        }
        await walk(abs);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = getExtension(name);
      if (!includeExt.has(ext)) {
        skippedExt++;
        sampleFilter(toPosix(relative(rootAbs, abs)), 'ext-not-whitelisted', ext || '(no-ext)');
        continue;
      }

      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }

      if (stat.size > maxFileSize) {
        skippedLarge++;
        sampleFilter(
          toPosix(relative(rootAbs, abs)),
          'too-large',
          `${Math.round(stat.size / 1024)}KB > ${Math.round(maxFileSize / 1024)}KB`,
        );
        continue;
      }

      const rel = toPosix(relative(rootAbs, abs));
      files.push({
        relPath: rel,
        absPath: abs,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  await walk(rootAbs);

  // 排序结果，稳定
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  return { files, skippedLarge, skippedExt, filterSamples };
}

// ─────────── helpers ───────────

function getExtension(name: string): string {
  const i = name.lastIndexOf('.');
  if (i < 0) return '';
  return name.slice(i).toLowerCase();
}

function toPosix(p: string): string {
  if (pathSep === '/') return p;
  return p.split(pathSep).join('/');
}

function isInside(target: string, root: string): boolean {
  const rel = relative(root, target);
  return !rel.startsWith('..') && !rel.startsWith('/') && !/^[a-zA-Z]:/.test(rel);
}
