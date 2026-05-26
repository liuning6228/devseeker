/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * append_file 工具 — 流式分段追加写入
 *
 * 来源：W15.6c · 解决 DeepSeek SSE 断连导致大文件写入失败的问题
 *
 * 设计思路：
 * - write_file 是"一次性写入"，必须把整个文件内容放在一个 tool_call 的 arguments 里
 * - 如果 SSE 流在传输过程中断裂，整个文件都写不进去
 * - append_file 允许 LLM 分段追加写入：先 write_file 创建文件头部，再多次 append_file 追加
 * - 每段只需 100-200 行，即使某次 SSE 断裂，之前写入的部分已经保存在磁盘上
 *
 * 参数：
 * - file_path（必填）：目标文件路径，相对路径相对于工作区根
 * - content（必填）：追加的文本内容
 *
 * 安全：同 write_file — 路径必须位于 workspaceRoot 内
 */

import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { detectLineNumberPrefix } from './result-formatter.js';
import { ErrorCodes } from '../errors/index.js';

const MAX_CONTENT_SIZE = 2 * 1024 * 1024; // 2 MB per append（比 write_file 小，鼓励分块）

export interface AppendFileArgs {
  file_path: string;
  content: string;
}

const parameters = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description:
        '目标文件路径（相对路径相对于工作区根；绝对路径必须落在工作区内）。文件必须已存在（由 write_file 或前一次 append_file 创建）。',
    },
    content: {
      type: 'string',
      description:
        '要追加到文件末尾的文本内容。不得包含行号前缀。每次追加建议 100-200 行，不要一次写太多。',
    },
  },
  required: ['file_path', 'content'],
  additionalProperties: false,
} as const;

export class AppendFileTool implements ITool<AppendFileArgs, ToolResult> {
  readonly name = 'append_file';
  readonly description =
    '向已存在的文件末尾追加内容。用于大文件分段写入：先用 write_file 写文件头部，再用 append_file 逐段追加，降低流中断导致全部丢失的风险。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'workspace_write';

  async execute(args: AppendFileArgs, ctx: ToolContext): Promise<ToolResult> {
    // 1. 参数校验
    if (!args || typeof args.file_path !== 'string' || !args.file_path.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'file_path 不能为空');
    }
    if (typeof args.content !== 'string') {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'content 必须是字符串');
    }
    if (args.content.length > MAX_CONTENT_SIZE) {
      return fail(
        ErrorCodes.TOOL_ARGS_INVALID,
        `content 过大（${(args.content.length / 1024 / 1024).toFixed(1)}MB > 2MB 上限）。请分多次追加，每次 100-200 行。`,
      );
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
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, '未打开工作区，无法写入文件');
    }

    let absPath: string;
    try {
      absPath = isAbsolute(args.file_path)
        ? resolvePath(args.file_path)
        : resolvePath(ctx.workspaceRoot, args.file_path);
    } catch (e) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, `路径解析失败：${(e as Error).message}`);
    }

    const rootReal = await safeRealpath(ctx.workspaceRoot);

    // 3. 路径安全：检查父目录是否在工作区内
    const parentAbs = dirname(absPath);
    const parentReal = await safeRealpath(parentAbs);
    const relParent = relative(rootReal, parentReal);
    if (relParent.startsWith('..') || isAbsolute(relParent)) {
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, `拒绝写入工作区外的文件：${args.file_path}`);
    }

    // 4. 取消信号
    if (ctx.signal.aborted) {
      return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
    }

    // 5. 文件必须已存在（必须先用 write_file 创建）
    let existed = false;
    try {
      const st = await fs.stat(absPath);
      if (!st.isFile()) {
        return fail(ErrorCodes.TOOL_ARGS_INVALID, `路径已存在且不是普通文件：${args.file_path}`);
      }
      existed = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return fail(
          ErrorCodes.TOOL_ARGS_INVALID,
          `文件不存在：${args.file_path}。请先用 write_file 创建文件，再用 append_file 追加内容。`,
        );
      }
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `stat 失败：${(e as Error).message}`);
    }

    // 6. 重复追加检测已移除（v2 架构：StreamingFileWriter 只写临时文件，不再污染真实文件）
    //    原检测逻辑因 SSE 断裂导致 LLM 反复追加相同章节而存在，
    //    现在 StreamingFileWriter v2 只写 .dualmind/tmp/ 临时文件，
    //    真实文件仅在工具正式执行时才被写入，不再出现重复追加问题。

    // 7. 追加写入
    try {
      await fs.appendFile(absPath, args.content, { encoding: 'utf-8' });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, `无权限写入：${args.file_path}`);
      }
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `写入失败：${(e as Error).message}`);
    }

    // 7. 读取追加后的总行数
    const appendedBytes = Buffer.byteLength(args.content, 'utf-8');
    const appendedLines = args.content.length === 0 ? 0 : args.content.split(/\r?\n/).length;
    let totalLines = 0;
    try {
      const fullContent = await fs.readFile(absPath, 'utf-8');
      totalLines = fullContent.split(/\r?\n/).length;
    } catch {
      // 忽略
    }

    const relPath = relative(rootReal, absPath).replace(/\\/g, '/');
    return {
      ok: true,
      content: `Appended ${appendedLines} lines (${appendedBytes} bytes) to ${relPath}. File now has ${totalLines} lines total.`,
      display: {
        filePath: relPath,
        mode: 'append',
        bytes: appendedBytes,
        lineCount: appendedLines,
        totalLines,
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
