/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * PDF 翻译编排与绘制层单测。
 *
 * 覆盖：
 * - 折行（CJK 断行 / ASCII 词不拆 / 超长词强拆）
 * - 字号适配（超长译文缩小、短译文保持原字号）
 * - 模型输出解析（围栏 / 杂讯 / 非法 JSON）
 * - 翻译器错误路径（无 provider / 无文本层）
 * - 端到端集成（需要 fonts/NotoSansSC-Regular.ttf；缺失时自动跳过）：
 *   mock provider 返回中文 → 输出 PDF 页数一致、文本层含中文、部分批失败降级
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  wrapCjkLines,
  fitTextBlock,
  type TextMeasurer,
} from '../../src/core/pdf/translate-paint.js';
import {
  createPdfTranslator,
  parseTranslatedArray,
} from '../../src/core/pdf/pdf-translate.js';
import { extractPdfTextLayer } from '../../src/core/pdf/extract.js';
import { buildValidPdf } from './pdf-fixtures.js';
import type { IProvider } from '../../src/providers/base.js';
import type { StreamEvent } from '../../src/providers/types.js';

const FONT_PATH = join(process.cwd(), 'fonts', 'NotoSansSC-Regular.ttf');
const hasFont = existsSync(FONT_PATH);
const describeIfFont = hasFont ? describe : describe.skip;

/** 简单度量：CJK 1em、ASCII 0.5em */
const measure: TextMeasurer = {
  widthOfTextAtSize(text, size) {
    let w = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      w += code > 0x2e7f ? size : size * 0.5;
    }
    return w;
  },
};

// ─────────── 折行 ───────────

describe('wrapCjkLines', () => {
  it('wraps long Chinese text per character', () => {
    const text = '这是一段很长的中文文本需要在指定宽度内自动折行处理';
    const lines = wrapCjkLines(text, 60, 10, measure); // 每行 6 个汉字
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(measure.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(60);
    }
    expect(lines.join('')).toBe(text);
  });

  it('does not split ASCII words across lines', () => {
    const lines = wrapCjkLines('Hello world example', 60, 10, measure);
    // 每词宽 2.5em=25pt；一行最多 2 词+空格
    expect(lines).toEqual(['Hello world', 'example']);
  });

  it('force-splits an oversized single word', () => {
    const lines = wrapCjkLines('Supercalifragilisticexpialidocious', 30, 10, measure);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('Supercalifragilisticexpialidocious');
  });

  it('returns empty array for empty input', () => {
    expect(wrapCjkLines('', 100, 10, measure)).toEqual([]);
  });

  it('keeps trailing punctuation on the line without losing text (regression)', () => {
    // 10 字 = 100pt 恰好放得下；「。」落下时溢出 → 应回贴当前行（允许微小溢出），
    // 不得把标点挂到上一行或丢弃中间文本（历史 bug）
    const text = '一二三四五六七八九十。';
    const lines = wrapCjkLines(text, 105, 10, measure);
    expect(lines.join('')).toBe(text);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('。')).toBe(true);
  });

  it('does not orphan punctuation on multi-line text (regression)', () => {
    const text = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸。';
    const lines = wrapCjkLines(text, 105, 10, measure);
    expect(lines.join('')).toBe(text);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[lines.length - 1]!.endsWith('。')).toBe(true);
    expect(lines.every((l) => l.length > 0)).toBe(true);
  });
});

describe('fitTextBlock', () => {
  it('keeps original size when translation fits', () => {
    const fit = fitTextBlock('短译文', {
      boxW: 200,
      boxH: 14,
      fontSize: 12,
      leading: 14,
      measure,
    });
    expect(fit.fontSize).toBe(12);
    expect(fit.lines.length).toBeLessThanOrEqual(2);
  });

  it('shrinks font when translation overflows the allowed lines', () => {
    const long = '很长的译文内容'.repeat(12); // 84 字
    const fit = fitTextBlock(long, {
      boxW: 120, // @10pt 每行 12 字 → 需 ~7 行，超过 maxLines=2
      boxH: 14,
      fontSize: 12,
      leading: 14,
      measure,
    });
    expect(fit.fontSize).toBeLessThan(12);
    expect(fit.fontSize).toBeGreaterThanOrEqual(6);
    for (const line of fit.lines) {
      expect(measure.widthOfTextAtSize(line, fit.fontSize)).toBeLessThanOrEqual(120);
    }
  });

  it('never goes below the 6pt floor', () => {
    const huge = '超'.repeat(2000);
    const fit = fitTextBlock(huge, {
      boxW: 80,
      boxH: 14,
      fontSize: 12,
      leading: 14,
      minSize: 6,
      measure,
    });
    expect(fit.fontSize).toBe(6);
  });
});

// ─────────── 输出解析 ───────────

describe('parseTranslatedArray', () => {
  it('parses a plain JSON array', () => {
    expect(parseTranslatedArray('["甲","乙"]')).toEqual(['甲', '乙']);
  });

  it('tolerates markdown fences and surrounding chatter', () => {
    expect(parseTranslatedArray('好的，结果如下：\n```json\n["一","二"]\n```\n完毕')).toEqual(['一', '二']);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseTranslatedArray('not json at all')).toThrow();
  });

  it('throws when not an array', () => {
    expect(() => parseTranslatedArray('{"a":1}')).toThrow();
  });
});

// ─────────── 翻译器：错误路径（无需字体） ───────────

describe('createPdfTranslator - error paths', () => {
  const signal = () => new AbortController().signal;

  it('fails with no-provider when provider is missing', async () => {
    const translator = createPdfTranslator({
      getProvider: () => undefined,
      resolveFontPath: () => FONT_PATH,
    });
    await expect(
      translator.translate(buildValidPdf(['Some English text here.']), { signal: signal() }),
    ).rejects.toMatchObject({ name: 'PdfTranslateError', code: 'no-provider' });
  });

  it('fails with no-text-layer for blank (image-like) PDFs', { timeout: 30_000 }, async () => {
    const provider = makeProvider(() => textStream('["译文"]'));
    const translator = createPdfTranslator({
      getProvider: () => provider.provider,
      resolveFontPath: () => FONT_PATH,
    });
    await expect(
      translator.translate(buildValidPdf(['']), { signal: signal() }),
    ).rejects.toMatchObject({ name: 'PdfTranslateError', code: 'no-text-layer' });
    expect(provider.calls()).toBe(0);
  });

  it('fails with page-range-invalid when all requested pages are out of range', { timeout: 30_000 }, async () => {
    const provider = makeProvider(() => textStream('["译文"]'));
    const translator = createPdfTranslator({
      getProvider: () => provider.provider,
      resolveFontPath: () => FONT_PATH,
    });
    await expect(
      translator.translate(buildValidPdf(['Some English sentence here.']), {
        signal: signal(),
        pages: [99],
      }),
    ).rejects.toMatchObject({ name: 'PdfTranslateError', code: 'page-range-invalid' });
    expect(provider.calls()).toBe(0);
  });

  it('fails with no-font when font file is missing', { timeout: 30_000 }, async () => {
    const provider = makeProvider((_i, texts) => textStream(JSON.stringify(texts.map((t) => `译:${t}`))));
    const translator = createPdfTranslator({
      getProvider: () => provider.provider,
      resolveFontPath: () => join(process.cwd(), 'fonts', 'no-such-font.ttf'),
    });
    await expect(
      translator.translate(buildValidPdf(['English sentence for font check.']), { signal: signal() }),
    ).rejects.toMatchObject({ name: 'PdfTranslateError', code: 'no-font' });
  });
});

// ─────────── 翻译器：端到端（需要真实字体） ───────────

describeIfFont('createPdfTranslator - integration (needs fonts/)', () => {
  it('translates a text PDF and keeps page count with Chinese text layer', { timeout: 60_000 }, async () => {
    const provider = makeProvider((_i, texts) =>
      textStream(JSON.stringify(texts.map((t, i) => `【中文译文${i + 1}】${t.slice(0, 6)}`))),
    );
    const translator = createPdfTranslator({
      getProvider: () => provider.provider,
      resolveFontPath: () => FONT_PATH,
      getConfig: () => ({ segmentsPerRequest: 12 }),
    });

    const input = buildValidPdf(['The quick brown fox jumps over the lazy dog.']);
    const result = await translator.translate(input, { signal: new AbortController().signal });

    expect(result.stats.segments).toBeGreaterThanOrEqual(1);
    expect(result.stats.translated).toBe(result.stats.segments);
    expect(result.stats.untranslated).toBe(0);

    // 输出可解析、页数一致、文本层包含中文（原英文仍在底层）
    const layer = await extractPdfTextLayer(result.outputBytes);
    expect(layer).not.toBeNull();
    expect(layer!.pageCount).toBe(1);
    expect(layer!.text).toContain('中文译文');
  });

  it('keeps untranslated segments and continues when one batch fails', { timeout: 60_000 }, async () => {
    // 13 页 = 13 段；每批 12 段 → 第 1 批成功，第 2 批（含重试）持续失败
    const pages = Array.from({ length: 13 }, (_, i) => `Page ${i + 1} English content for batch test.`);
    let call = 0;
    const provider = makeProvider((_i, texts) => {
      call++;
      if (call === 1) {
        return textStream(JSON.stringify(texts.map((t) => `译:${t}`)));
      }
      return textStream('this is not a json array');
    });

    const translator = createPdfTranslator({
      getProvider: () => provider.provider,
      resolveFontPath: () => FONT_PATH,
      getConfig: () => ({ segmentsPerRequest: 12 }),
    });

    const result = await translator.translate(buildValidPdf(pages), {
      signal: new AbortController().signal,
    });

    expect(result.stats.segments).toBe(13);
    expect(result.stats.translated).toBe(12);
    expect(result.stats.untranslated).toBe(1);
    // 输出仍生成且页数一致
    const layer = await extractPdfTextLayer(result.outputBytes);
    expect(layer!.pageCount).toBe(13);
    expect(layer!.text).toContain('译:Page 1');
  });

  it('reports abort via PdfTranslateError/aborted semantics', { timeout: 30_000 }, async () => {
    const provider = makeProvider((_i, texts) => textStream(JSON.stringify(texts)));
    const translator = createPdfTranslator({
      getProvider: () => provider.provider,
      resolveFontPath: () => FONT_PATH,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      translator.translate(buildValidPdf(['Some English sentence here.']), {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
  });
});

// ─────────── helpers ───────────

function textStream(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', text },
    { type: 'done', reason: 'stop' },
  ];
}

/** mock provider：从 prompt 中解析输入数组，交给 handler 生成事件 */
function makeProvider(handler: (callIndex: number, texts: string[]) => StreamEvent[]) {
  let count = 0;
  const provider = {
    id: 'fake-llm',
    capabilities: ['text'],
    contextWindow: 32_000,
    pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'CNY' },
    createMessage(options: { messages: Array<{ content: unknown }> }) {
      const content = String(options.messages[0]?.content ?? '');
      const start = content.indexOf('[');
      const end = content.lastIndexOf(']');
      let texts: string[] = [];
      if (start >= 0 && end > start) {
        try {
          texts = JSON.parse(content.slice(start, end + 1)) as string[];
        } catch {
          texts = [];
        }
      }
      const events = handler(count, texts);
      count++;
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    probe: async () => ({ ok: true, latencyMs: 1 }),
    countTokens: async () => 1,
    updateApiKey: () => undefined,
  };
  return {
    provider: provider as unknown as IProvider,
    calls: () => count,
  };
}
