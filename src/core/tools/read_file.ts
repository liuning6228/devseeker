/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * read_file 工具
 *
 * 来源：DESIGN §M9.1 / §M9.2.2 / §M9.2.1（行号前缀）
 *
 * 参数约束：
 * - file_path 必须先给（LLM 生成顺序）
 * - start_line / end_line 可选，1-based inclusive
 * - 无范围时读整个文件（推荐小文件）
 *
 * 安全：
 * - 路径必须落在 workspaceRoot 内（realpath resolve 后 startsWith）
 * - 不跟随符号链接到工作区外
 * - 不读大于 5MB 的文件（防止 OOM）
 *
 * 输出：
 * - 带行号前缀（M9.2.1）
 * - 超过 2000 行且未指定范围 → 末尾追加 hint
 */

import { promises as fs } from 'node:fs';
import { resolve as resolvePath, relative, isAbsolute } from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { formatWithLineNumbers } from './result-formatter.js';
import { ErrorCodes } from '../errors/index.js';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const LARGE_FILE_HINT_THRESHOLD = 2000; // lines

export interface ReadFileArgs {
  file_path: string;
  start_line?: number;
  end_line?: number;
}

const parameters = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description:
        '要读取的文件路径。相对路径将相对于工作区根解析；绝对路径必须落在工作区内。',
    },
    start_line: {
      type: 'integer',
      minimum: 1,
      description: '起始行号（1-based，包含）。省略则从第 1 行开始。',
    },
    end_line: {
      type: 'integer',
      minimum: 1,
      description: '结束行号（1-based，包含）。省略则读到文件末尾。',
    },
  },
  required: ['file_path'],
  additionalProperties: false,
} as const;

export class ReadFileTool implements ITool<ReadFileArgs, ToolResult> {
  readonly name = 'read_file';
  readonly description =
    '读取工作区内文件内容，输出带行号前缀（" 12→content"）。可选 start_line / end_line 做范围读取。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  async execute(args: ReadFileArgs, ctx: ToolContext): Promise<ToolResult> {
    // 1. 参数校验
    if (!args || typeof args.file_path !== 'string' || !args.file_path.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'file_path 不能为空');
    }
    const { file_path, start_line, end_line } = args;

    if (start_line != null && (!Number.isInteger(start_line) || start_line < 1)) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'start_line 必须是 >= 1 的整数');
    }
    if (end_line != null && (!Number.isInteger(end_line) || end_line < 1)) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'end_line 必须是 >= 1 的整数');
    }
    if (start_line != null && end_line != null && end_line < start_line) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'end_line 必须 >= start_line');
    }

    // 2. 路径解析与安全校验
    if (!ctx.workspaceRoot) {
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, '未打开工作区，无法读取文件');
    }

    let absPath: string;
    try {
      absPath = isAbsolute(file_path)
        ? resolvePath(file_path)
        : resolvePath(ctx.workspaceRoot, file_path);
    } catch (e) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, `路径解析失败：${(e as Error).message}`);
    }

    // realpath 以应对 symlink；文件不存在时 realpath 会抛 ENOENT → 走下方统一处理
    let realPath: string;
    try {
      realPath = await fs.realpath(absPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return fail(ErrorCodes.TOOL_PATH_INVALID, `文件不存在：${file_path}`);
      }
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, `路径访问失败：${(e as Error).message}`);
    }

    const rootReal = await safeRealpath(ctx.workspaceRoot);
    const rel = relative(rootReal, realPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return fail(
        ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        `拒绝读取工作区外的文件：${file_path}`,
      );
    }

    // 3. 读取文件
    let content: string;
    try {
      // 取消信号支持（取消后抛 AbortError）
      if (ctx.signal.aborted) {
        return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
      }
      const stat = await fs.stat(realPath);
      if (!stat.isFile()) {
        return fail(ErrorCodes.TOOL_ARGS_INVALID, `路径不是文件：${file_path}`);
      }
      if (stat.size > MAX_FILE_SIZE) {
        return fail(
          ErrorCodes.TOOL_EXEC_FAILED,
          `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB > 5MB 上限）：${file_path}`,
        );
      }

      content = await fs.readFile(realPath, { encoding: 'utf-8' });
      // §8.11.2 · 记录文件修改时间到缓存供冲突检测
      if (ctx.fileStateCache && stat) {
        ctx.fileStateCache.record(realPath, stat.mtimeMs);
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, `无权限读取：${file_path}`);
      }
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `读取失败：${(e as Error).message}`);
    }

    // 4. 行范围切片
    const allLines = content.split(/\r?\n/);
    // 兼容末尾换行产生的空字符串尾项
    const hasTrailingNewline = content.endsWith('\n');
    const totalLines = hasTrailingNewline ? allLines.length - 1 : allLines.length;

    const s = Math.max(1, start_line ?? 1);
    const e = Math.min(totalLines, end_line ?? totalLines);

    if (s > totalLines) {
      return ok(
        `Contents of ${file_path} (${totalLines} lines total). Requested range ${s}-${end_line ?? 'EOF'} is out of range.\n`,
        { filePath: file_path, totalLines, shown: 0 },
      );
    }

    const sliced = allLines.slice(s - 1, e).join('\n') + (e < totalLines || hasTrailingNewline ? '\n' : '');
    const numbered = formatWithLineNumbers(sliced, s);

    // 5. 组装最终内容
    const header =
      start_line == null && end_line == null
        ? `Contents of ${file_path}, from line 1-${totalLines} (total ${totalLines} lines)\n\`\`\`\n`
        : `Contents of ${file_path}, from line ${s}-${e} (total ${totalLines} lines)\n\`\`\`\n`;
    const footer = '```\n';

    let body = header + numbered + footer;

    // 6. 大文件提示
    if (start_line == null && end_line == null && totalLines > LARGE_FILE_HINT_THRESHOLD) {
      body += `\n> File too large (${totalLines} lines). Prefer line-ranged reads.\n`;
    }

    return ok(body, { filePath: file_path, totalLines, shown: e - s + 1 });
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

function ok(content: string, display?: Record<string, unknown>): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}) };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
