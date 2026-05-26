/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * write_file 工具
 *
 * 来源：DESIGN §M9.2 workspace_write 工具
 *
 * 参数：
 * - file_path（必填）：目标文件路径，相对路径相对于工作区根
 * - content（必填）：写入的完整文件内容（create/overwrite 语义）
 * - mode（可选）：'create' | 'overwrite' | 'append'，默认 'overwrite'
 *   - create：若文件已存在 → 失败
 *   - overwrite：覆盖现有文件，文件不存在则创建
 *   - append：追加到现有文件末尾，文件不存在则创建
 *
 * 安全：
 * - 路径必须位于 workspaceRoot 内
 * - 不跟随 symlink 到工作区外
 * - content 前缀若被 "N→" 格式污染 → 立即拒绝（防止把行号写进文件）
 * - 父目录不存在会自动 mkdir -p
 *
 * 返回：
 * - bytesWritten / lineCount / final path
 */

import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { detectLineNumberPrefix } from './result-formatter.js';
import { ErrorCodes } from '../errors/index.js';
import { getLogger } from '../../infra/logger.js';
import { validateSettingsEdit } from './settings-validator.js';

const log = getLogger('write-file');

const MAX_CONTENT_SIZE = 5 * 1024 * 1024; // 5 MB

export type WriteFileMode = 'create' | 'overwrite' | 'append';

export interface WriteFileArgs {
  file_path: string;
  content: string;
  mode?: WriteFileMode;
}

const parameters = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description:
        '目标文件路径。相对路径相对于工作区根；绝对路径必须落在工作区内。',
    },
    content: {
      type: 'string',
      description:
        '要写入的文件完整内容。不得包含行号前缀（"  12→..." 这种来自 read_file 的元数据）。',
    },
    mode: {
      type: 'string',
      enum: ['create', 'overwrite', 'append'],
      description:
        '写入模式：create=仅新建（已存在则失败）；overwrite=覆盖（默认）；append=追加。',
    },
  },
  required: ['file_path', 'content'],
  additionalProperties: false,
} as const;

export class WriteFileTool implements ITool<WriteFileArgs, ToolResult> {
  readonly name = 'write_file';
  readonly description =
    '创建或覆盖工作区内的文件。mode=create 需文件不存在，overwrite 覆盖，append 追加；父目录会自动创建。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'workspace_write';

  async execute(args: WriteFileArgs, ctx: ToolContext): Promise<ToolResult> {
    // 1. 参数校验
    if (!args || typeof args.file_path !== 'string' || !args.file_path.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'file_path 不能为空');
    }
    if (typeof args.content !== 'string') {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'content 必须是字符串');
    }
    const mode: WriteFileMode = args.mode ?? 'overwrite';
    // W15.9 · 智能模式变量（在路径解析后赋值）
    let effectiveMode: WriteFileMode = mode;
    let effectiveContent = args.content;

    if (mode !== 'create' && mode !== 'overwrite' && mode !== 'append') {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `mode 必须是 create/overwrite/append 之一，收到 "${mode}"`,
      );
    }
    if (args.content.length > MAX_CONTENT_SIZE) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `content 过大（${(args.content.length / 1024 / 1024).toFixed(1)}MB > 5MB 上限）`,
      );
    }
    // W15.10 · 大文件智能提示（替代原 200 行硬限制）：
    // 原硬限制导致 LLM 无法一次性生成完整文件，必须拆分 write_file + append_file，
    // 但 LLM 极少能正确完成多步拆分序列，失败率更高。
    // 新策略：允许任意行数写入，但对大文件返回提示信息引导 LLM 选择更安全的工具。
    // StreamingFileWriter 已在 tool_args_delta 阶段流式写磁盘，SSE 断裂时已有部分落盘。
    const contentLines = args.content.split('\n').length;
    const LARGE_FILE_WARNING_THRESHOLD = 500;
    let largeFileHint = '';
    if (contentLines > LARGE_FILE_WARNING_THRESHOLD && mode !== 'append') {
      largeFileHint =
        ` [提示: 文件 ${contentLines} 行较大，如果网络中断导致内容不完整，` +
        `请用 read_file 检查已写入内容，然后用 append_file 追加缺失部分，` +
        `或用 search_replace 做局部修改。对于已有文件的大幅修改，建议优先使用 search_replace。]`;
    }
    const pollutedLine = detectLineNumberPrefix(args.content);
    if (pollutedLine !== null) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `content 第 ${pollutedLine} 行检测到行号前缀（"N→..."），请去掉 read_file 输出的行号元数据后再写入`,
      );
    }

    // 2. 工作区边界
    if (!ctx.workspaceRoot) {
      return fail(
        ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        '未打开工作区，无法写入文件',
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

    const rootReal = await safeRealpath(ctx.workspaceRoot);

    // W15.9 · 智能模式判断：当 mode 未指定（默认 overwrite）且文件已存在时，
    // 自动检测更安全的写入方式：
    // - 新内容完全等于现有内容 → 跳过（幂等）
    // - 新内容以现有内容开头 → 自动改为 append（只追加新增部分）
    // - 两者完全不同 → 正常 overwrite（文件替换）
    if (mode === 'overwrite' && !args.mode) {
      try {
        const existingContent = await fs.readFile(absPath, 'utf-8');
        if (existingContent === args.content) {
          // 内容完全相同 → 幂等，返回成功但不写
          const relPath2 = relative(rootReal, absPath).replace(/\\/g, '/');
          const bytes = Buffer.byteLength(args.content, 'utf-8');
          const lineCount = args.content.length === 0 ? 0 : args.content.split(/\r?\n/).length;
          return {
            ok: true,
            content: `No change: ${relPath2} content unchanged (${bytes} bytes, ${lineCount} lines).`,
            display: { filePath: relPath2, mode: 'overwrite', existed: true, bytes: 0, lineCount },
          };
        }
        // 检测新内容是否以现有内容开头（追加场景）
        if (args.content.length > existingContent.length && args.content.startsWith(existingContent)) {
          effectiveMode = 'append';
          effectiveContent = args.content.slice(existingContent.length);
        }
      } catch {
        // 文件不存在，跳过智能检测
      }
    }

    // 3. 路径安全：检查父目录是否在工作区内（文件可能不存在所以对父目录做 realpath）
    const parentAbs = dirname(absPath);
    const parentReal = await safeRealpath(parentAbs);
    const relParent = relative(rootReal, parentReal);
    if (relParent.startsWith('..') || isAbsolute(relParent)) {
      return fail(
        ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        `拒绝写入工作区外的文件：${args.file_path}`,
      );
    }

    // 4. 取消信号
    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    // 4.5 文件变更冲突检测（§8.11.2）
    if (ctx.fileStateCache) {
      const cached = ctx.fileStateCache.get(absPath);
      if (cached) {
        try {
          const currentStat = await fs.stat(absPath);
          if (cached.recordedMtimeMs !== currentStat.mtimeMs) {
            return fail(
              ErrorCodes.TOOL_PATCH_CONFLICT,
              `文件已被外部修改（mtime 从 ${cached.recordedMtimeMs} 变为 ${currentStat.mtimeMs}）。` +
              `请先 read_file 获取最新内容再重试。`,
            );
          }
        } catch {
          // 文件不存在（create 场景），跳过冲突检测
        }
      }
    }

    // 5. mode 语义检查
    let exists = false;
    try {
      const st = await fs.stat(absPath);
      if (!st.isFile()) {
        return fail(
          ErrorCodes.TOOL_ARGS_INVALID,
          `路径已存在且不是普通文件：${args.file_path}`,
        );
      }
      exists = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        return fail(
          ErrorCodes.TOOL_EXEC_FAILED,
          `stat 失败：${(e as Error).message}`,
        );
      }
    }

    if (effectiveMode === 'create' && exists) {
      return fail(
        ErrorCodes.TOOL_EXEC_FAILED,
        `文件已存在（mode=create）：${args.file_path}`,
      );
    }

    // 6. 内容退化保护已移除（v2 架构：StreamingFileWriter 只写临时文件，不再污染真实文件）
    //    原保护逻辑因 SSE 断裂导致真实文件被部分内容污染而存在，
    //    现在 StreamingFileWriter v2 只写 .dualmind/tmp/ 临时文件，
    //    真实文件仅在 write_file 工具正式执行时才被写入，不存在退化风险。

    // 7. 创建父目录（mkdirp，确保路径中的每一级目录都存在）
    try {
      await fs.mkdir(parentAbs, { recursive: true });
    } catch (e) {
      return fail(
        ErrorCodes.TOOL_EXEC_FAILED,
        `创建父目录失败：${(e as Error).message}`,
      );
    }

    // 7.5 Settings 文件写保护校验（§8.11.3）
    const validation = validateSettingsEdit(absPath, effectiveContent);
    if (!validation.valid) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `${validation.errorMessage}\n原始文件未被修改。请修正 content 后重试。`,
      );
    }

    // 8. 实际写入 — 原子写入（tmp+rename）保证可靠性
    //    参考 Cline 的 atomicWriteFile：先写临时文件，再 rename 到目标。
    //    rename 在同一文件系统上是原子操作，避免写入中途断电/崩溃导致文件损坏。
    //    如果 rename 失败（跨盘符等），回退到直接 writeFile。
    try {
      if (effectiveMode === 'append') {
        await fs.appendFile(absPath, effectiveContent, { encoding: 'utf-8' });
      } else {
        await atomicWriteFile(absPath, effectiveContent);
      }
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

    const bytes = Buffer.byteLength(effectiveContent, 'utf-8');
    const lineCount = effectiveContent.length === 0 ? 0 : effectiveContent.split(/\r?\n/).length;
    const relPath = relative(rootReal, absPath).replace(/\\/g, '/');
    const action = effectiveMode === 'append' ? 'Appended' : exists ? 'Overwrote' : 'Created';
    const smartHint = effectiveMode !== mode ? ` (smart: ${mode}→${effectiveMode})` : '';

    return {
      ok: true,
      content: `${action} ${relPath} (${bytes} bytes, ${lineCount} lines).${smartHint}${largeFileHint}`,
      display: {
        filePath: relPath,
        mode,
        existed: exists,
        bytes,
        lineCount,
      },
    };
  }
}

// ─────────── helpers ───────────

/**
 * 原子写入文件：先写临时文件，再 rename 到目标路径。
 * 参考 Cline 的 atomicWriteFile 实现：
 * - rename 在同一文件系统上是原子操作，避免中途断电/崩溃导致文件损坏
 * - 如果 rename 失败（如跨盘符），回退到直接 writeFile
 */
async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 9)}`;
  try {
    // 先写临时文件
    await fs.writeFile(tmpPath, data, { encoding: 'utf-8' });
    // 原子 rename 到目标
    await fs.rename(tmpPath, filePath);
  } catch (renameError) {
    // 清理临时文件
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    // rename 可能因跨盘符等原因失败，回退到直接写入
    try {
      await fs.writeFile(filePath, data, { encoding: 'utf-8' });
    } catch {
      // 直接写入也失败，抛出原始错误
      throw renameError;
    }
  }
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return resolvePath(p);
  }
}

function fail(code: string, message: string): ToolResult {
  log.warn({ code, message }, 'write_file failed');
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
