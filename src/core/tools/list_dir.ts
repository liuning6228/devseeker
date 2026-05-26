/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * list_dir 工具
 *
 * 来源：DESIGN §M9.2 read_only 工具
 *
 * 行为：
 * - 列出指定目录下的文件/子目录
 * - 默认跳过常见噪声目录（node_modules / .git / dist / out 等）
 * - show_hidden=false 时跳过以 . 开头的条目
 * - 控制递归深度（max_depth，默认 1；1 表示只列一级）
 *
 * 安全：
 * - dir_path 必须位于 workspaceRoot 内（realpath + startsWith 校验）
 * - 不跟随 symlink 到工作区外
 * - 输出条目上限 MAX_ENTRIES，超出给 hint 截断
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';

const MAX_ENTRIES = 500;
const DEFAULT_EXCLUDES = new Set([
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
  'target', // rust/java
  '.vscode-test',
]);

export interface ListDirArgs {
  dir_path?: string;
  max_depth?: number;
  show_hidden?: boolean;
}

const parameters = {
  type: 'object',
  properties: {
    dir_path: {
      type: 'string',
      description:
        '要列出的目录路径。相对路径相对于工作区根；缺省为工作区根目录 "."。',
    },
    max_depth: {
      type: 'integer',
      minimum: 1,
      maximum: 5,
      description: '最大递归深度，默认 1（只列一级），最大 5。',
    },
    show_hidden: {
      type: 'boolean',
      description: '是否显示以 "." 开头的隐藏文件，默认 false。',
    },
  },
  additionalProperties: false,
} as const;

export class ListDirTool implements ITool<ListDirArgs, ToolResult> {
  readonly name = 'list_dir';
  readonly description =
    '列出工作区内目录的内容（文件/子目录）。默认跳过 node_modules/.git/dist/out 等噪声目录。可选 max_depth 控制递归层数。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  async execute(args: ListDirArgs, ctx: ToolContext): Promise<ToolResult> {
    const dirPath = (args?.dir_path ?? '.').trim() || '.';
    const maxDepth = clampInt(args?.max_depth, 1, 5, 1);
    const showHidden = args?.show_hidden === true;

    if (!ctx.workspaceRoot) {
      return fail(
        ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        '未打开工作区，无法列目录',
      );
    }

    // 路径解析 + 安全校验
    let absPath: string;
    try {
      absPath = isAbsolute(dirPath)
        ? resolvePath(dirPath)
        : resolvePath(ctx.workspaceRoot, dirPath);
    } catch (e) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, `路径解析失败：${(e as Error).message}`);
    }

    let realPath: string;
    try {
      realPath = await fs.realpath(absPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return fail(ErrorCodes.TOOL_PATH_INVALID, `目录不存在：${dirPath}`);
      }
      return fail(
        ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        `路径访问失败：${(e as Error).message}`,
      );
    }

    const rootReal = await safeRealpath(ctx.workspaceRoot);
    const rel = relative(rootReal, realPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return fail(
        ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        `拒绝列出工作区外的目录：${dirPath}`,
      );
    }

    const stat = await fs.stat(realPath);
    if (!stat.isDirectory()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, `路径不是目录：${dirPath}`);
    }

    // 递归遍历
    const entries: string[] = [];
    let truncated = false;
    try {
      truncated = await walk(
        realPath,
        rootReal,
        0,
        maxDepth,
        showHidden,
        entries,
        ctx.signal,
      );
    } catch (e) {
      if (ctx.signal.aborted) {
        return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
      }
      return fail(
        ErrorCodes.TOOL_EXEC_FAILED,
        `读取目录失败：${(e as Error).message}`,
      );
    }

    const shownPath = rel === '' ? '.' : rel.replace(/\\/g, '/');
    const header = `Contents of "${shownPath}" (${entries.length} entries, max_depth=${maxDepth}):\n`;
    const body = entries.join('\n') + (entries.length > 0 ? '\n' : '');
    const footer = truncated
      ? `\n> Truncated: more than ${MAX_ENTRIES} entries. Use a deeper sub-path to narrow the listing.\n`
      : '';

    return {
      ok: true,
      content: header + body + footer,
      display: {
        dirPath: shownPath,
        entryCount: entries.length,
        truncated,
      },
    };
  }
}

// ─────────── helpers ───────────

/**
 * 递归遍历目录，追加到 entries。
 * 返回 true 表示因上限截断。
 */
async function walk(
  dir: string,
  rootReal: string,
  depth: number,
  maxDepth: number,
  showHidden: boolean,
  entries: string[],
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) throw new Error('aborted');
  if (entries.length >= MAX_ENTRIES) return true;

  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  // 稳定排序：目录优先 + 字典序
  dirents.sort((a, b) => {
    const da = a.isDirectory() ? 0 : 1;
    const db = b.isDirectory() ? 0 : 1;
    return da !== db ? da - db : a.name.localeCompare(b.name);
  });

  for (const d of dirents) {
    if (signal.aborted) throw new Error('aborted');
    if (entries.length >= MAX_ENTRIES) return true;

    if (!showHidden && d.name.startsWith('.')) continue;
    if (DEFAULT_EXCLUDES.has(d.name)) continue;

    const childAbs = resolvePath(dir, d.name);
    const rel = relative(rootReal, childAbs).replace(/\\/g, '/');
    const suffix = d.isDirectory() ? '/' : '';
    entries.push(rel + suffix);

    if (d.isDirectory() && depth + 1 < maxDepth) {
      const truncated = await walk(
        childAbs,
        rootReal,
        depth + 1,
        maxDepth,
        showHidden,
        entries,
        signal,
      );
      if (truncated) return true;
    }
  }
  return false;
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return resolvePath(p);
  }
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return dflt;
  return Math.min(max, Math.max(min, v));
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
