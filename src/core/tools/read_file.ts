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
import { resolve as resolvePath, relative, isAbsolute, extname } from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { formatWithLineNumbers } from './result-formatter.js';
import { ErrorCodes } from '../errors/index.js';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const LARGE_FILE_HINT_THRESHOLD = 2000; // lines

/** 可通过文档提取管道读取的二进制文件扩展名 */
const BINARY_DOC_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp',
]);
/** 其中仅 LiteParse 支持的格式（非 PDF） */
const LITEPARSE_ONLY_EXTENSIONS = new Set([
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp',
]);

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
    '读取工作区内文件内容，输出带行号前缀（" 12→content"）。可选 start_line / end_line 做范围读取。' +
    '支持 PDF / Excel / Word / PPT 等二进制文档自动提取文本。';
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
    const ext = extname(realPath).toLowerCase();

    // 3a. 二进制文档格式 → 走文档提取管道
    if (BINARY_DOC_EXTENSIONS.has(ext)) {
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
      const extracted = await extractDocumentText(realPath, ext);
      if (!extracted) {
        const formatName = ext === '.pdf' ? 'PDF' : ext.replace('.', '').toUpperCase();
        if (ext === '.pdf') {
          return fail(
            ErrorCodes.TOOL_EXEC_FAILED,
            `PDF 文本提取失败（可能是扫描件或加密文件）：${file_path}。建议用 bash 安装 poppler-utils 后执行 pdftotext。`,
          );
        }
        return fail(
          ErrorCodes.TOOL_EXEC_FAILED,
          `${formatName} 文件读取失败：${file_path}。` +
          '当前环境未安装 @llamaindex/liteparse（可选依赖）。' +
          '可通过 bash 工具安装：npm install @llamaindex/liteparse，' +
          '或用 Python pandas/openpyxl 读取 Excel。',
        );
      }
      // 提取成功 → 走下方行号格式化
      if (ctx.fileStateCache) {
        ctx.fileStateCache.record(realPath, stat.mtimeMs);
      }
      content = extracted;
    } else {
      // 3b. 普通文本文件
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

// ─────────── 二进制文档提取 ───────────

/**
 * 从二进制文档（PDF / Excel / Word / PPT）中提取纯文本。
 *
 * 策略：
 * - PDF → pdfjs-dist（已内置，支持中文 PDF）
 * - Office 格式 → @llamaindex/liteparse（optionalDependency，需用户安装）
 *
 * @param absPath 文件绝对路径
 * @param ext 小写扩展名（含点号）
 * @returns 提取的文本，失败返回 null
 */
async function extractDocumentText(absPath: string, ext: string): Promise<string | null> {
  // PDF → pdfjs-dist
  if (ext === '.pdf') {
    return await extractPdfText(absPath);
  }

  // Office 格式 → LiteParse
  if (LITEPARSE_ONLY_EXTENSIONS.has(ext)) {
    return await extractWithLiteParse(absPath);
  }

  return null;
}

/**
 * 使用 pdfjs-dist 提取 PDF 文本。
 * 复用 asset-indexer/pdf.ts 的提取逻辑，但只返回文本字符串。
 */
async function extractPdfText(absPath: string): Promise<string | null> {
  try {
    // Node.js 环境必须用 legacy 构建，否则 DOMMatrix is not defined
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = '';
    }

    const data = new Uint8Array(await fs.readFile(absPath));
    const doc = await pdfjs.getDocument({ data }).promise;
    const maxPages = Math.min(doc.numPages, 100);
    const pages: string[] = [];

    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = textContent.items as any[];
      // 按垂直位置排序还原阅读顺序
      const sorted = items.slice().sort((a: any, b: any) => {
        const aY = Math.round(a.transform?.[5] ?? 0);
        const bY = Math.round(b.transform?.[5] ?? 0);
        if (Math.abs(aY - bY) < 10) return 0;
        return bY - aY;
      });
      const text = sorted
        .map((item: any) => item.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) pages.push(text);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (doc as any).destroy();

    const fullText = pages.join('\n\n');
    return fullText.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 使用 @llamaindex/liteparse 提取 Office 文档文本。
 * LiteParse 是 optionalDependency，不可用时返回 null。
 */
async function extractWithLiteParse(absPath: string): Promise<string | null> {
  try {
    // 动态导入，不可用时抛异常被捕获
    const mod = await tryLoadLiteParse();
    if (!mod) return null;

    const parser = new mod.LiteParse({
      ocrEnabled: false,
      quiet: true,
      outputFormat: 'text',
      maxPages: 100,
    });
    const result = await parser.parse(absPath);
    const text = result?.text?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * 尝试加载 @llamaindex/liteparse。不可用时返回 null。
 */
async function tryLoadLiteParse(): Promise<any | null> {
  try {
    return await import('@llamaindex/liteparse');
  } catch {
    return null;
  }
}
