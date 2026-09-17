/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * VLLM 视觉转录 Runner —— 图片 PDF（扫描件）的视觉识别通道。
 *
 * 流程：PDF 字节 → 渲染为逐页 JPEG（render.ts）→ 逐页串行调用
 * VLLM 视觉 provider（qwen-vl-max / gpt-4o / claude 等）转录 → 分页聚合。
 *
 * 设计：
 * - provider 缺失或 enabled=false → run() 返回 null（调用方走原有降级路径）
 * - 逐页串行（顺序稳定、进度可推送、失败隔离）；页间检查 AbortSignal
 * - 单页失败不中断：该页以 `[Page N: recognition failed]` 占位继续
 * - 连续性系统故障保护：从未成功且连续 3 页失败时提前终止（避免对坏配置
 *   打满整份文档的失败请求）
 * - 全部页失败 → 返回 null
 *
 * 该模块不依赖 vscode：provider 与配置均由调用方注入（panel.ts 负责接线）。
 */

import type { IProvider } from '../../providers/base.js';
import type { Message } from '../../providers/types.js';
import { renderPdfPagesToDataUrls, type RenderedPdfPages } from './render.js';

/** 视觉 OCR 运行时配置 */
export interface VisionOcrConfig {
  /** 功能开关（false 时 run() 直接返回 null） */
  enabled: boolean;
  /** 渲染缩放（默认 1.5） */
  scale: number;
  /** JPEG 质量（默认 80） */
  quality: number;
  /** 最大处理页数（0 = 全部页面） */
  maxPages: number;
}

/** 默认配置（未注入 getConfig 时使用） */
export const DEFAULT_VISION_OCR_CONFIG: VisionOcrConfig = {
  enabled: true,
  scale: 1.5,
  quality: 80,
  maxPages: 0,
};

/** 转录结果 */
export interface VisionOcrResult {
  /** 分页拼接文本（`--- Page N ---` 分隔，失败页有占位符） */
  text: string;
  /** 成功识别的页数 */
  pages: number;
  /** 识别失败的页码（含渲染失败页，1-based） */
  failedPages: number[];
  /** 渲染失败被跳过的页码（1-based） */
  skippedRenderPages: number[];
}

/** 视觉 OCR Runner（read_file 通过依赖注入调用） */
export interface VisionOcrRunner {
  /**
   * 用视觉模型识别图片 PDF。
   * @param data PDF 文件字节
   * @param opts signal 必传；onProgress 为进度文本（中文，可直接推给 UI）
   * @returns 成功（至少一页识别成功）返回结果；未配置/禁用/全部失败返回 null
   * @throws AbortError 语义（signal 取消时）与渲染层不可恢复错误
   */
  run(
    data: Uint8Array,
    opts: { signal: AbortSignal; onProgress?: (message: string) => void },
  ): Promise<VisionOcrResult | null>;
}

/** Runner 工厂依赖（均可注入，便于单测） */
export interface CreateVisionOcrRunnerDeps {
  /** 视觉 provider 获取器（每次调用时解析，设置变更即时生效） */
  getProvider: () => IProvider | undefined;
  /** 配置获取器 */
  getConfig?: () => VisionOcrConfig;
  /** 渲染实现（默认 renderPdfPagesToDataUrls；单测可注入 fake） */
  renderPages?: (data: Uint8Array, opts?: Parameters<typeof renderPdfPagesToDataUrls>[1]) => Promise<RenderedPdfPages>;
}

/** 单页转录指令（英文稳定；要求保持原语言不翻译） */
const TRANSCRIBE_PROMPT = [
  'You are a precise document transcription engine. The image is one page of a PDF document that has no selectable text layer.',
  'Transcribe ALL visible text on the page faithfully and completely.',
  '',
  'Rules:',
  '- Preserve the reading order, headings, paragraphs, lists, and tables (render tables as GitHub-flavored Markdown).',
  '- Keep the original language; do not translate.',
  '- Reproduce numbers, codes, identifiers, and punctuation exactly as shown.',
  '- For figures or charts, add a brief description in the form [Figure: ...].',
  '- For formulas, use LaTeX notation when possible.',
  '- If the page contains no text at all, output exactly: [blank page]',
  '- Output only the transcription content. Do not add commentary, page markers, or code fences around the whole output.',
].join('\n');

/** 单页最大输出 tokens */
const MAX_TOKENS_PER_PAGE = 4096;

/** 系统性故障保护阈值：从未成功且连续失败达到该值时提前终止 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 创建视觉转录 Runner。
 */
export function createVisionOcrRunner(deps: CreateVisionOcrRunnerDeps): VisionOcrRunner {
  const renderPages = deps.renderPages ?? renderPdfPagesToDataUrls;

  return {
    async run(data, opts) {
      const provider = deps.getProvider();
      if (!provider) return null;

      const cfg = deps.getConfig?.() ?? DEFAULT_VISION_OCR_CONFIG;
      if (!cfg.enabled) return null;

      assertNotAborted(opts.signal);

      // 1. 渲染全部页面为 JPEG DataURL
      const rendered = await renderPages(data, {
        scale: cfg.scale,
        quality: cfg.quality,
        maxPages: cfg.maxPages > 0 ? cfg.maxPages : undefined,
        signal: opts.signal,
        onPage: (page, total) => opts.onProgress?.(`正在渲染 PDF 页面（${page}/${total}）…`),
      });

      const totalToProcess = rendered.pages.length + rendered.skipped.length;
      if (totalToProcess === 0) return null;

      // 2. 逐页串行转录（渲染失败页直接计入 failedPages）
      const skippedSet = new Set(rendered.skipped);
      const transcriptions = new Map<number, string>();
      const failedPages: number[] = [];
      let imageIndex = 0;
      let consecutiveFailures = 0;

      for (let page = 1; page <= totalToProcess; page++) {
        assertNotAborted(opts.signal);

        if (skippedSet.has(page)) {
          failedPages.push(page);
          continue;
        }

        const dataUrl = rendered.pages[imageIndex++];
        if (!dataUrl) {
          failedPages.push(page);
          continue;
        }

        try {
          const text = await transcribePage(provider, dataUrl, opts.signal);
          transcriptions.set(page, text);
          consecutiveFailures = 0;
        } catch (e) {
          // 取消优先：abort 时向上抛，不再按「页失败」吞掉
          assertNotAborted(opts.signal);
          failedPages.push(page);
          consecutiveFailures++;
          // 系统性故障保护：从未成功且连续失败 → 提前终止（避免打满整份文档）
          if (transcriptions.size === 0 && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            break;
          }
        }

        opts.onProgress?.(`正在用视觉模型识别 PDF（${page}/${totalToProcess} 页）…`);
      }

      const successPages = transcriptions.size;
      if (successPages === 0) return null;

      // 3. 按页序聚合（失败页保留占位符，保证文本结构可读）
      const parts: string[] = [];
      for (let page = 1; page <= totalToProcess; page++) {
        parts.push(`--- Page ${page} ---`);
        const ok = transcriptions.get(page);
        if (ok === undefined) {
          parts.push(`[Page ${page}: recognition failed]`);
        } else {
          parts.push(ok.length > 0 ? ok : '[blank page]');
        }
      }

      return {
        text: parts.join('\n'),
        pages: successPages,
        failedPages,
        skippedRenderPages: [...rendered.skipped],
      };
    },
  };
}

/**
 * 单页转录：一次 vision 调用，累积 text_delta 文本。
 * provider 错误（error 事件 / 流内异常）以 throw 形式上抛，由调用方决定是否继续。
 */
async function transcribePage(provider: IProvider, dataUrl: string, signal: AbortSignal): Promise<string> {
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: TRANSCRIBE_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
      ],
    },
  ];

  let out = '';
  let streamError: string | undefined;

  for await (const ev of provider.createMessage({
    messages,
    maxTokens: MAX_TOKENS_PER_PAGE,
    temperature: 0,
    signal,
  })) {
    if (ev.type === 'text_delta') {
      out += ev.text;
    } else if (ev.type === 'error') {
      streamError = ev.error.message;
      break;
    } else if (ev.type === 'done') {
      if (ev.reason === 'error' && !streamError) streamError = 'provider stream ended with error';
      break;
    }
  }

  if (streamError) throw new Error(streamError);
  assertNotAborted(signal);
  return out.trim();
}

/** 统一取消检查：抛出 name='AbortError' 的错误 */
function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error('vision OCR aborted');
    err.name = 'AbortError';
    throw err;
  }
}
