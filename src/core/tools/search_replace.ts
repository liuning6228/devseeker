/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * search_replace 工具
 *
 * 来源：DESIGN §M9.2 workspace_write 工具
 *
 * 行为：
 * - 在指定文件中把 old_string 替换成 new_string
 * - replace_all=false（默认）时 old_string 必须在文件中唯一出现（锚定校验）
 * - replace_all=true 时替换所有匹配
 * - old_string === new_string 时拒绝（空替换无意义）
 *
 * 安全：
 * - 文件路径必须在 workspaceRoot 内
 * - old_string / new_string 不得包含行号前缀
 * - 文件不存在时返回 TOOL_PATH_INVALID
 * - 匹配不到 → TOOL_PATCH_NO_MATCH
 * - 多处匹配 + replace_all=false → TOOL_PATCH_UNIQUE_FAIL
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { detectLineNumberPrefix } from './result-formatter.js';
import { ErrorCodes } from '../errors/index.js';
import { multiLevelMatch, exactMatchCount, preserveQuoteStyle } from './fuzzy-match.js';
import { FileStateCache } from './file-state-cache.js';
import { validateSettingsEdit } from './settings-validator.js';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

export interface SearchReplaceArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const parameters = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description:
        '目标文件路径。相对路径相对于工作区根；绝对路径必须落在工作区内。',
    },
    old_string: {
      type: 'string',
      description:
        '要被替换的精确字符串（默认模式下必须在文件中唯一出现）。保留原始缩进/换行，不得含行号前缀。',
    },
    new_string: {
      type: 'string',
      description: '替换后的新字符串。不得含行号前缀。',
    },
    replace_all: {
      type: 'boolean',
      description:
        '是否替换所有出现位置。默认 false（要求 old_string 唯一）；true 时替换全部匹配。',
    },
  },
  required: ['file_path', 'old_string', 'new_string'],
  additionalProperties: false,
} as const;

export class SearchReplaceTool implements ITool<SearchReplaceArgs, ToolResult> {
  readonly name = 'search_replace';
  readonly description =
    '在工作区内的文件中执行字符串替换。支持多级匹配：精确匹配 → 行空白容忍匹配 → 模糊匹配（Levenshtein 相似度≥90%）。默认要求 old_string 唯一匹配，replace_all=true 可替换全部。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'workspace_write';

  async execute(args: SearchReplaceArgs, ctx: ToolContext): Promise<ToolResult> {
    // 1. 参数校验
    if (!args || typeof args.file_path !== 'string' || !args.file_path.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'file_path 不能为空');
    }
    if (typeof args.old_string !== 'string' || args.old_string.length === 0) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'old_string 不能为空');
    }
    if (typeof args.new_string !== 'string') {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'new_string 必须是字符串');
    }
    if (args.old_string === args.new_string) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        'old_string 与 new_string 相同，无需替换',
      );
    }
    const replaceAll = args.replace_all === true;

    const oldPolluted = detectLineNumberPrefix(args.old_string);
    if (oldPolluted !== null) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `old_string 第 ${oldPolluted} 行检测到行号前缀（"N→..."），请去除 read_file 输出的元数据后重试`,
      );
    }
    const newPolluted = detectLineNumberPrefix(args.new_string);
    if (newPolluted !== null) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `new_string 第 ${newPolluted} 行检测到行号前缀（"N→..."），请去除后重试`,
      );
    }

    // 2. 工作区边界
    if (!ctx.workspaceRoot) {
      return fail(
        ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        '未打开工作区，无法修改文件',
      );
    }

    let absPath: string;
    try {
      absPath = isAbsolute(args.file_path)
        ? resolvePath(args.file_path)
        : resolvePath(ctx.workspaceRoot, args.file_path);
    } catch (e) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `路径解析失败：${(e as Error).message}`,
      );
    }

    let realPath: string;
    try {
      realPath = await fs.realpath(absPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return fail(ErrorCodes.TOOL_PATH_INVALID, `文件不存在：${args.file_path}`);
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
        `拒绝修改工作区外的文件：${args.file_path}`,
      );
    }

    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    // 3. 读取并匹配
    let original: string;
    try {
      const stat = await fs.stat(realPath);
      if (!stat.isFile()) {
        return fail(
          ErrorCodes.TOOL_ARGS_INVALID,
          `路径不是文件：${args.file_path}`,
        );
      }
      if (stat.size > MAX_FILE_SIZE) {
        return fail(
          ErrorCodes.TOOL_EXEC_FAILED,
          `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB > 5MB 上限）：${args.file_path}`,
        );
      }
      original = await fs.readFile(realPath, { encoding: 'utf-8' });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        return fail(
          ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
          `无权限读取：${args.file_path}`,
        );
      }
      return fail(
        ErrorCodes.TOOL_EXEC_FAILED,
        `读取失败：${(e as Error).message}`,
      );
    }

    // 2.5 文件变更冲突检测（§8.11.2）
    if (ctx.fileStateCache) {
      const cached = ctx.fileStateCache.get(realPath);
      if (cached) {
        let currentStat: { mtimeMs: number };
        try {
          currentStat = await fs.stat(realPath);
        } catch {
          return fail(ErrorCodes.TOOL_PATH_INVALID, `文件不存在：${args.file_path}`);
        }
        if (cached.recordedMtimeMs !== currentStat.mtimeMs) {
          return fail(
            ErrorCodes.TOOL_PATCH_CONFLICT,
            `文件已被外部修改（mtime 从 ${cached.recordedMtimeMs} 变为 ${currentStat.mtimeMs}）。` +
            `请先 read_file 获取最新内容再重试。`,
          );
        }
      }
    }

    // 3. 多级 fallback 匹配（精确 → 行 trim → Levenshtein 模糊）
    // 先检查精确匹配次数（用于 replace_all 模式和唯一性校验）
    const exactCount = exactMatchCount(original, args.old_string);

    if (exactCount > 1 && !replaceAll) {
      return fail(
        ErrorCodes.TOOL_PATCH_UNIQUE_FAIL,
        `old_string 在 ${args.file_path} 中出现 ${exactCount} 次，请加更多上下文使其唯一，或设置 replace_all=true`,
      );
    }

    if (exactCount === 0) {
      // 精确匹配失败，尝试多级 fallback
      const matchResult = multiLevelMatch(original, args.old_string, {
        threshold: 0.9,
        allowFuzzy: true,
      });

      if (!matchResult.matched) {
        // 所有级别都未匹配
        return fail(
          ErrorCodes.TOOL_PATCH_NO_MATCH,
          `old_string 在 ${args.file_path} 中未找到匹配（已尝试精确匹配、行空白容忍匹配和模糊匹配）。` +
          `请用 read_file 查看文件实际内容后重试。`,
        );
      }

      // 模糊匹配成功 — 执行替换
      if (matchResult.matchLevel === 'line-trim') {
        // 行 trim 匹配：用原始文件中的实际文本作为替换目标
        const updated = original.replace(matchResult.matchedText, args.new_string);
        return await writeBack(realPath, updated, args.file_path, rel,
          `Replaced 1 occurrence in ${rel.replace(/\\/g, '/')} (行空白容忍匹配). ` +
          `建议用 read_file 验证替换结果。`);
      }

      if (matchResult.matchLevel === 'quote-normalized') {
        // 引号归一化匹配：自动保留文件原文的引号风格
        const preservedNew = preserveQuoteStyle(matchResult.matchedText, args.new_string);
        const updated = original.replace(matchResult.matchedText, preservedNew);
        return await writeBack(realPath, updated, args.file_path, rel,
          `Replaced 1 occurrence in ${rel.replace(/\\/g, '/')} (引号归一化匹配). ` +
          `建议用 read_file 验证替换结果。`);
      }

      if (matchResult.matchLevel === 'fuzzy') {
        // 模糊匹配：用原始文件中最相似的片段作为替换目标
        const updated = original.replace(matchResult.matchedText, args.new_string);
        const simPercent = Math.floor(matchResult.similarity * 100);
        return await writeBack(realPath, updated, args.file_path, rel,
          `Replaced 1 occurrence in ${rel.replace(/\\/g, '/')} (模糊匹配, 相似度 ${simPercent}%). ` +
          `建议用 read_file 验证替换结果。`);
      }
    }

    // 4. 执行替换
    const updated = replaceAll
      ? original.split(args.old_string).join(args.new_string)
      : original.replace(args.old_string, args.new_string);

    // 4.5 Settings 文件写保护校验（§8.11.3）
    const validation = validateSettingsEdit(realPath, updated);
    if (!validation.valid) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `${validation.errorMessage}\n请检查 new_string 中的引号/逗号/花括号是否完整。原始文件未被修改。`,
      );
    }

    // 5. 写回
    try {
      await fs.writeFile(realPath, updated, { encoding: 'utf-8' });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        return fail(
          ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
          `无权限写入：${args.file_path}`,
        );
      }
      return fail(
        ErrorCodes.TOOL_EXEC_FAILED,
        `写入失败：${(e as Error).message}`,
      );
    }

    const replaced = replaceAll ? exactCount : 1;
    const relPath = rel.replace(/\\/g, '/');
    return {
      ok: true,
      content: `Replaced ${replaced} occurrence${replaced === 1 ? '' : 's'} in ${relPath}.`,
      display: {
        filePath: relPath,
        replacedCount: replaced,
        oldBytes: Buffer.byteLength(args.old_string, 'utf-8'),
        newBytes: Buffer.byteLength(args.new_string, 'utf-8'),
      },
    };
  }
}

// ─────────── helpers ───────────

/** 写回文件并返回结果（供模糊匹配路径复用） */
async function writeBack(
  realPath: string,
  updatedContent: string,
  _filePath: string,
  rel: string,
  message: string,
): Promise<ToolResult> {
  try {
    await fs.writeFile(realPath, updatedContent, { encoding: 'utf-8' });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return fail(
        ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        `无权限写入：${_filePath}`,
      );
    }
    return fail(
      ErrorCodes.TOOL_EXEC_FAILED,
      `写入失败：${(e as Error).message}`,
    );
  }
  const relPath = rel.replace(/\\/g, '/');
  return {
    ok: true,
    content: message,
    display: {
      filePath: relPath,
      replacedCount: 1,
      oldBytes: 0,
      newBytes: Buffer.byteLength(updatedContent, 'utf-8'),
    },
  };
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return resolvePath(p);
  }
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
