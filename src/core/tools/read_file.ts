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
 * - 不读大于 5MB 的文件（防止 OOM）；PDF 在视觉 OCR 可用时放宽至 50MB
 *
 * 文档提取：
 * - PDF 文本层 → ../pdf/extract.ts（无文本层时视觉识别兜底，见 ../pdf/vision-ocr.ts）
 * - Office 格式 → LiteParse（本文件内 helper）
 *
 * 输出：
 * - 带行号前缀（M9.2.1）
 * - 超过 2000 行且未指定范围 → 末尾追加 hint
 */

import { promises as fs } from 'node:fs';
import { resolve as resolvePath, relative, isAbsolute, extname } from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { formatWithLineNumbers } from './result-formatter.js';
import { isDelegatePathAllowed } from '../subagent/delegate-guards.js';
import { extractPdfTextLayer, type PdfTextLayerResult } from '../pdf/extract.js';
import { extractWithLiteParse } from '../pdf/liteparse.js';
import type { VisionOcrRunner } from '../pdf/vision-ocr.js';
import { ErrorCodes } from '../errors/index.js';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
/** 视觉 OCR 可用时的 PDF 上限（扫描件常超 5MB；逐页渲染内存可控） */
const MAX_PDF_WITH_OCR_SIZE = 50 * 1024 * 1024; // 50 MB
const LARGE_FILE_HINT_THRESHOLD = 2000; // lines

/** 可通过文档提取管道读取的二进制文件扩展名 */
const BINARY_DOC_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
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

/** read_file 可选依赖（生产由 panel.ts 注入；单测可不传） */
export interface ReadFileDeps {
  /**
   * 视觉 OCR Runner 获取器（图片 PDF / 扫描件兜底识别）。
   * 未注入或返回 undefined = 不做视觉识别，走既有降级错误提示。
   */
  getVisionOcr?: () => VisionOcrRunner | undefined;
}

export class ReadFileTool implements ITool<ReadFileArgs, ToolResult> {
  readonly name = 'read_file';
  readonly description =
    '读取工作区内文件内容，输出带行号前缀（" 12→content"）。可选 start_line / end_line 做范围读取。' +
    '支持 PDF / Excel / Word / PPT 等二进制文档自动提取文本；图片 PDF（扫描件）可通过视觉模型识别。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'read_only';
  /**
   * 图片 PDF 视觉识别为分钟级长耗时（逐页渲染 + 逐页转录）；
   * 默认 30s 工具超时会中断整条链路，与 Agent 工具同量级放宽到 600s。
   */
  readonly executionTimeoutMs = 600_000;

  constructor(private readonly deps: ReadFileDeps = {}) {}

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

    // 2b. 子代理角色范围（如 Guide 仅允许 .devseeker/ + docs/ + AGENTS.md）
    const readPrefixes = ctx.delegate?.readPathPrefixes;
    if (readPrefixes && readPrefixes.length > 0 && !isDelegatePathAllowed(rel, readPrefixes)) {
      return fail(
        ErrorCodes.SUBAGENT_TOOL_NOT_ALLOWED,
        `子代理（${ctx.delegate!.role}）仅允许读取：${readPrefixes.join(' / ')}；拒绝：${file_path}`,
      );
    }

    // 3. 读取文件
    let content: string;
    /** 内容来源附加说明（如视觉模型转录），拼进最终 header */
    let sourceNote = '';
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

      // PDF 且有视觉 OCR 可用时放宽大小上限（扫描件常超 5MB）
      const visionOcr = ext === '.pdf' ? this.deps.getVisionOcr?.() : undefined;
      const sizeLimit = visionOcr ? MAX_PDF_WITH_OCR_SIZE : MAX_FILE_SIZE;
      if (stat.size > sizeLimit) {
        return fail(
          ErrorCodes.TOOL_EXEC_FAILED,
          `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB > ${Math.round(sizeLimit / 1024 / 1024)}MB 上限）：${file_path}`,
        );
      }

      if (ext === '.pdf') {
        // ── PDF：文本层提取 → 无文本层时视觉识别兜底 ──
        const bytes = await fs.readFile(realPath);
        const layer = await extractPdfTextLayer(bytes);

        if (layer?.usable) {
          content = layer.text;
        } else if (layer) {
          // 能解析但无可用文本层（图片 PDF / 扫描件）
          const outcome = await this.extractPdfViaVision(bytes, file_path, layer, visionOcr, ctx);
          if (outcome.kind === 'error') {
            return fail(outcome.code, outcome.message);
          }
          content = outcome.text;
          sourceNote = outcome.note;
        } else {
          // 无法解析：损坏 / 加密 / 非法格式
          return fail(
            ErrorCodes.TOOL_EXEC_FAILED,
            `PDF 解析失败（疑似加密或文件损坏）：${file_path}。` +
            (visionOcr ? '视觉识别同样依赖 PDF 解析，无法对加密文件生效。' : ''),
          );
        }
      } else {
        // ── Office 格式：LiteParse 通道 ──
        const extracted = await extractWithLiteParse(realPath);
        if (!extracted) {
          const formatName = ext.replace('.', '').toUpperCase();
          return fail(
            ErrorCodes.TOOL_EXEC_FAILED,
            `${formatName} 文件读取失败：${file_path}。` +
            'LiteParse 文档提取不可用或失败（可选依赖加载异常 / 文档损坏 / 格式不受支持）；' +
            '可改用 bash 工具处理（如 Python pandas/openpyxl 读取 Excel、python-docx 读取 Word）。',
          );
        }
        content = extracted;
      }

      // 提取成功 → 走下方行号格式化
      if (ctx.fileStateCache) {
        ctx.fileStateCache.record(realPath, stat.mtimeMs);
      }
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
        ? `Contents of ${file_path}, from line 1-${totalLines} (total ${totalLines} lines)${sourceNote}\n\`\`\`\n`
        : `Contents of ${file_path}, from line ${s}-${e} (total ${totalLines} lines)${sourceNote}\n\`\`\`\n`;
    const footer = '```\n';

    let body = header + numbered + footer;

    // 6. 大文件提示
    if (start_line == null && end_line == null && totalLines > LARGE_FILE_HINT_THRESHOLD) {
      body += `\n> File too large (${totalLines} lines). Prefer line-ranged reads.\n`;
    }

    return ok(body, { filePath: file_path, totalLines, shown: e - s + 1 });
  }

  /**
   * 图片 PDF 视觉识别兜底（整体兜底策略：全部页面渲染 → VLLM 逐页转录）。
   *
   * 降级规则：
   * - 未注入 Runner 或未启用：残余文本可用则返回残余文本，否则报「未配置视觉模型」
   * - Runner 返回 null（全部页失败）：同上回退
   * - Runner 抛错：取消优先；其余情况回退残余文本或报「视觉识别失败」
   */
  private async extractPdfViaVision(
    bytes: Uint8Array,
    filePath: string,
    layer: PdfTextLayerResult,
    visionOcr: VisionOcrRunner | undefined,
    ctx: ToolContext,
  ): Promise<{ kind: 'text'; text: string; note: string } | { kind: 'error'; code: string; message: string }> {
    const residual = layer.text.trim();

    if (!visionOcr) {
      if (residual) return { kind: 'text', text: layer.text, note: '' };
      return {
        kind: 'error',
        code: ErrorCodes.TOOL_EXEC_FAILED,
        message:
          `PDF 无可用文本层（图片 PDF / 扫描件）：${filePath}。` +
          '未配置视觉模型（VLLM），无法识别图片内容；' +
          '可在 DevSeeker 设置中配置视觉模型，或用 bash 安装 poppler-utils 后执行 pdftoppm + OCR。',
      };
    }

    ctx.emitOutput?.(`[read_file] PDF 无文本层，尝试视觉模型识别（共 ${layer.pageCount} 页）…`);
    try {
      const ocr = await visionOcr.run(bytes, {
        signal: ctx.signal,
        onProgress: (m) => ctx.emitOutput?.(m),
      });
      if (ocr) {
        const total = ocr.pages + ocr.failedPages.length;
        const note = `, scanned PDF, transcribed by vision model (${ocr.pages}/${total} page(s) recognized)`;
        return { kind: 'text', text: ocr.text, note };
      }
      // Runner 返回 null：未启用 / 全部页面失败
      if (residual) return { kind: 'text', text: layer.text, note: '' };
      return {
        kind: 'error',
        code: ErrorCodes.TOOL_EXEC_FAILED,
        message:
          `PDF 无文本层且视觉识别失败（所有页面均失败）：${filePath}。` +
          '请检查视觉模型（VLLM）配置、API Key 与网络连通性。',
      };
    } catch (e) {
      if (ctx.signal.aborted) {
        return { kind: 'error', code: ErrorCodes.TASK_LOOP_ABORTED, message: '任务已取消' };
      }
      if (residual) return { kind: 'text', text: layer.text, note: '' };
      return {
        kind: 'error',
        code: ErrorCodes.TOOL_EXEC_FAILED,
        message: `视觉识别失败：${(e as Error).message}：${filePath}`,
      };
    }
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
