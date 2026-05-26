/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * delete_file 工具（W7e2）
 *
 * 来源：DESIGN §M9.2 + §M15.3（Checkpoint 集成）
 *
 * 职责：删除工作区内的单个文件。删除前由 Checkpoint 自动快照（通过
 * TRACKED_WRITE_TOOLS 白名单 + `file_path` 参数名约定，无需工具侧改动）。
 *
 * 参数：
 * - file_path（必填）：目标文件路径，相对路径相对于工作区根，绝对路径必须在工作区内
 *
 * 行为：
 * - 路径不存在 → 返回成功（幂等，display.existed=false）
 * - 路径是目录 → 失败（MVP 只支持文件删除）
 * - 路径是符号链接 → 删除链接本身（fs.unlink 行为），不跟随
 *
 * 安全：
 * - 路径必须落在 workspaceRoot 内（realpath + relative 检查）
 * - 不支持递归目录删除（避免灾难性误删，后续可加 recursive 参数 + 审批）
 * - 通过 Checkpoint 机制可 Revert（删除前自动快照原内容）
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';

export interface DeleteFileArgs {
  file_path: string;
}

const parameters = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description:
        '要删除的文件路径。相对路径相对于工作区根；绝对路径必须落在工作区内。只支持文件，不支持目录。',
    },
  },
  required: ['file_path'],
  additionalProperties: false,
} as const;

export class DeleteFileTool implements ITool<DeleteFileArgs, ToolResult> {
  readonly name = 'delete_file';
  readonly description =
    '删除工作区内的单个文件（不支持目录）。删除前由 Checkpoint 自动快照，可通过 "revert" 命令撤回。路径不存在时视为幂等成功。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'workspace_write';

  async execute(args: DeleteFileArgs, ctx: ToolContext): Promise<ToolResult> {
    // 1. 参数校验
    if (!args || typeof args.file_path !== 'string' || !args.file_path.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'file_path 不能为空');
    }

    // 2. 工作区边界
    if (!ctx.workspaceRoot) {
      return fail(
        ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        '未打开工作区，无法删除文件',
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
    // 用父目录 realpath 判断边界（文件自身可能是 symlink，realpath 会跟随，失真）
    const parentAbs = resolvePath(absPath, '..');
    const parentReal = await safeRealpath(parentAbs);
    const relParent = relative(rootReal, parentReal);
    if (relParent.startsWith('..') || isAbsolute(relParent)) {
      return fail(
        ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        `拒绝删除工作区外的文件：${args.file_path}`,
      );
    }

    // 3. 取消信号
    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    // 4. 检查目标：不存在 → 幂等成功；是目录 → 失败
    const relPath = relative(rootReal, absPath).replace(/\\/g, '/');
    let bytes: number | undefined;
    try {
      const st = await fs.lstat(absPath);
      if (st.isDirectory()) {
        return fail(
          ErrorCodes.TOOL_ARGS_INVALID,
          `路径是目录，delete_file 不支持目录删除：${args.file_path}`,
        );
      }
      if (st.isFile()) bytes = st.size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          ok: true,
          content: `File not found (no-op): ${relPath}`,
          display: { filePath: relPath, existed: false },
        };
      }
      return fail(
        ErrorCodes.TOOL_EXEC_FAILED,
        `lstat 失败：${(e as Error).message}`,
      );
    }

    // 5. 实际删除
    try {
      await fs.unlink(absPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        return fail(
          ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
          `无权限删除：${args.file_path}`,
        );
      }
      if (code === 'ENOENT') {
        // 竞态：刚才还在，现在没了 → 视为幂等
        return {
          ok: true,
          content: `File not found (no-op): ${relPath}`,
          display: { filePath: relPath, existed: false },
        };
      }
      return fail(
        ErrorCodes.TOOL_EXEC_FAILED,
        `删除失败：${(e as Error).message}`,
      );
    }

    const sizeHint = bytes !== undefined ? ` (${bytes} bytes)` : '';
    return {
      ok: true,
      content: `Deleted ${relPath}${sizeHint}.`,
      display: {
        filePath: relPath,
        existed: true,
        ...(bytes !== undefined ? { bytes } : {}),
      },
    };
  }
}

// ─────────── helpers ───────────

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
