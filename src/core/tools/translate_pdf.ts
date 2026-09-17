/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * translate_pdf 工具 —— 英文 PDF → 简体中文（版面保留）翻译。
 *
 * 依赖注入（panel.ts 接线）PdfTranslator；本工具只负责：
 * - 参数/路径安全校验（workspace 内读写）
 * - 输出路径决策（默认 <原名>.zh.pdf；已存在默认拒绝）
 * - 调用翻译器 + 写盘 + 回执统计
 *
 * 安全：workspace_write（走审批门）；executionTimeoutMs=600s（分钟级长任务）。
 */

import { promises as fs } from 'node:fs';
import { resolve as resolvePath, relative, isAbsolute, extname, dirname, basename, join } from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';
import {
  PdfTranslateError,
  type PdfTranslator,
  type PdfTranslateStats,
} from '../pdf/pdf-translate.js';

/** 输入 PDF 大小上限（含扫描件级大文件；翻译只需文本层） */
const MAX_INPUT_SIZE = 50 * 1024 * 1024;

export interface TranslatePdfArgs {
  file_path: string;
  output_path?: string;
  overwrite?: boolean;
  page_range?: string;
}

const parameters = {
  type: 'object',
  properties: {
    file_path: {
      type: 'string',
      description: '要翻译的英文 PDF 路径（工作区内）；相对路径基于工作区根。',
    },
    output_path: {
      type: 'string',
      description: '输出路径（可选）；默认同目录下 <原名>.zh.pdf。',
    },
    overwrite: {
      type: 'boolean',
      description: '允许覆盖已存在的输出文件；默认 false（已存在时报错）。',
    },
    page_range: {
      type: 'string',
      description: '页码范围（可选），如 "1-10" / "3" / "1-5,8"；省略 = 全部页面。',
    },
  },
  required: ['file_path'],
  additionalProperties: false,
} as const;

/** translate_pdf 可选依赖（生产由 panel.ts 注入；单测可不传） */
export interface TranslatePdfDeps {
  /** 翻译器获取器（未注入 = 功能不可用） */
  getTranslator?: () => PdfTranslator | undefined;
}

export class TranslatePdfTool implements ITool<TranslatePdfArgs, ToolResult> {
  readonly name = 'translate_pdf';
  readonly description =
    '把英文 PDF 翻译为简体中文并生成新的 PDF 文件（保持原排版结构、图片与矢量元素不变）。' +
    '适合技术文档/白皮书；扫描件（无文本层）不支持，大文档可用 page_range 分批翻译。';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'workspace_write';
  /** 全文档翻译为分钟级长耗时（版面提取 + 多批 LLM + 回写） */
  readonly executionTimeoutMs = 600_000;

  constructor(private readonly deps: TranslatePdfDeps = {}) {}

  async execute(args: TranslatePdfArgs, ctx: ToolContext): Promise<ToolResult> {
    // 1. 参数校验
    if (!args || typeof args.file_path !== 'string' || !args.file_path.trim()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, 'file_path 不能为空');
    }
    const { file_path, output_path, overwrite, page_range } = args;

    let pages: number[] | undefined;
    if (page_range != null) {
      const parsed = parsePageRange(page_range);
      if (!parsed) {
        return fail(
          ErrorCodes.TOOL_ARGS_INVALID,
          `page_range 格式无效：${page_range}（示例："1-10" / "3" / "1-5,8"）`,
        );
      }
      pages = parsed;
    }

    if (!ctx.workspaceRoot) {
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, '未打开工作区，无法翻译文件');
    }
    const rootReal = await safeRealpath(ctx.workspaceRoot);

    // 2. 输入路径安全（与 read_file 同规则）
    let inputReal: string;
    try {
      const abs = isAbsolute(file_path) ? resolvePath(file_path) : resolvePath(ctx.workspaceRoot, file_path);
      inputReal = await fs.realpath(abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return fail(ErrorCodes.TOOL_PATH_INVALID, `文件不存在：${file_path}`);
      }
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, `路径访问失败：${(e as Error).message}`);
    }
    if (!isInside(rootReal, inputReal)) {
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, `拒绝读取工作区外的文件：${file_path}`);
    }
    if (extname(inputReal).toLowerCase() !== '.pdf') {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, `仅支持 PDF 文件：${file_path}`);
    }

    const stat = await fs.stat(inputReal);
    if (!stat.isFile()) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, `路径不是文件：${file_path}`);
    }
    if (stat.size > MAX_INPUT_SIZE) {
      return fail(
        ErrorCodes.TOOL_EXEC_FAILED,
        `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB > ${MAX_INPUT_SIZE / 1024 / 1024}MB 上限）：${file_path}`,
      );
    }

    // 3. 输出路径决策与安全
    const defaultOut = join(
      dirname(inputReal),
      `${basename(inputReal).replace(/\.pdf$/i, '')}.zh.pdf`,
    );
    const outAbs = output_path
      ? (isAbsolute(output_path) ? resolvePath(output_path) : resolvePath(ctx.workspaceRoot, output_path))
      : defaultOut;

    const outParent = dirname(outAbs);
    try {
      await fs.mkdir(outParent, { recursive: true });
    } catch (e) {
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `创建输出目录失败：${(e as Error).message}`);
    }
    const parentReal = await safeRealpath(outParent);
    if (!isInside(rootReal, parentReal)) {
      return fail(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED, `拒绝写入工作区外：${outAbs}`);
    }
    if (outAbs === inputReal) {
      return fail(ErrorCodes.TOOL_ARGS_INVALID, '输出路径不能与输入文件相同');
    }
    if (!overwrite) {
      const exists = await pathExists(outAbs);
      if (exists) {
        return fail(
          ErrorCodes.TOOL_EXEC_FAILED,
          `输出文件已存在：${outAbs}。请指定新的 output_path，或设置 overwrite=true 覆盖。`,
        );
      }
    }

    // 4. 翻译器可用性
    const translator = this.deps.getTranslator?.();
    if (!translator) {
      return fail(
        ErrorCodes.TOOL_EXEC_FAILED,
        '翻译功能不可用（未配置 LLM Provider 或翻译器未接入）',
      );
    }

    // 5. 读取 + 翻译
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(inputReal);
    } catch (e) {
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `读取失败：${(e as Error).message}`);
    }

    try {
      const result = await translator.translate(bytes, {
        signal: ctx.signal,
        onProgress: (m) => ctx.emitOutput?.(m),
        ...(pages ? { pages } : {}),
      });

      // 6. 写盘
      try {
        await fs.writeFile(outAbs, result.outputBytes);
      } catch (e) {
        return fail(ErrorCodes.TOOL_EXEC_FAILED, `写入输出文件失败：${(e as Error).message}`);
      }

      const relOut = toPosix(relative(rootReal, outAbs));
      return ok(formatSummary(relOut, result.stats), {
        outputPath: relOut,
        stats: result.stats,
      });
    } catch (e) {
      if (ctx.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
        return fail(ErrorCodes.TASK_LOOP_ABORTED, '任务已取消');
      }
      if (e instanceof PdfTranslateError) {
        return fail(ErrorCodes.TOOL_EXEC_FAILED, mapTranslateError(e, file_path));
      }
      return fail(ErrorCodes.TOOL_EXEC_FAILED, `翻译失败：${(e as Error).message}`);
    }
  }
}

// ─────────── helpers ───────────

/** 解析页码范围："1-10" / "3" / "1-5,8" → [1..10,3,...]（去重升序） */
export function parsePageRange(input: string): number[] | null {
  const s = input.trim();
  if (!s) return null;
  const pages = new Set<number>();
  for (const part of s.split(',')) {
    const seg = part.trim();
    if (!seg) return null;
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(seg);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] != null ? Number(m[2]) : a;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) return null;
    if (b - a > 5000) return null; // 防误输入超大范围
    for (let p = a; p <= b; p++) pages.add(p);
  }
  return [...pages].sort((x, y) => x - y);
}

function mapTranslateError(e: PdfTranslateError, filePath: string): string {
  switch (e.code) {
    case 'no-provider':
      return '未配置 LLM Provider，无法翻译。请在 DevSeeker 设置中配置模型（LLM 轨）。';
    case 'no-font':
      return e.message;
    case 'no-text-layer':
      return `该 PDF 没有可翻译的文本层（可能是扫描件/图片 PDF）：${filePath}。可先用图片 PDF 视觉识别通道处理。`;
    case 'already-chinese':
      return `PDF 内容已以中文为主，无需翻译：${filePath}`;
    case 'translate-failed':
      return e.message;
    case 'aborted':
      return '翻译已取消';
    default:
      // 含 page-range-invalid 等：直接使用翻译器给出的具体原因
      return `${e.message}：${filePath}`;
  }
}

function formatSummary(relOut: string, stats: PdfTranslateStats): string {
  const parts: string[] = [];
  parts.push('Translation complete.');
  parts.push('');
  parts.push(`- Output: ${relOut}`);
  parts.push(`- Pages processed: ${stats.processedPages}/${stats.totalPages}`);
  parts.push(`- Segments: ${stats.translated}/${stats.segments} translated`);
  if (stats.untranslated > 0) {
    parts.push(`- Untranslated segments kept in English: ${stats.untranslated} (translation batch failed)`);
  }
  parts.push(`- Duration: ${(stats.durationMs / 1000).toFixed(1)}s (${stats.batches} LLM calls)`);
  return parts.join('\n');
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return resolvePath(p);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

function ok(content: string, display?: Record<string, unknown>): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}) };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, errorCode: code };
}
