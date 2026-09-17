/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * TranslatePdfTool 单测
 *
 * 覆盖：参数/页码范围校验、路径安全（越界/不存在/非 PDF）、
 * 默认输出命名、已存在拒绝与 overwrite、翻译器依赖缺失、
 * 页码透传、PdfTranslateError 映射、取消语义。
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { TranslatePdfTool, parsePageRange } from '../../src/core/tools/translate_pdf.js';
import {
  PdfTranslateError,
  type PdfTranslator,
  type PdfTranslateStats,
} from '../../src/core/pdf/pdf-translate.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dualmind-translate-pdf-'));
  // 工具层不解析 PDF 内容（解析在 translator 内），占位字节即可
  const fakePdf = Buffer.from('%PDF-1.4 fake bytes for tool-level tests');
  await fs.writeFile(path.join(root, 'doc.pdf'), fakePdf);
  await fs.writeFile(path.join(root, 'a.pdf'), fakePdf);
  await fs.writeFile(path.join(root, 'b.pdf'), fakePdf);
  await fs.writeFile(path.join(root, 'c.pdf'), fakePdf);
  await fs.writeFile(path.join(root, 'note.txt'), 'not a pdf');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function ctx(signal = new AbortController().signal) {
  return { workspaceRoot: root, signal, taskId: 't1', toolCallId: 'c1' };
}

const fakeStats: PdfTranslateStats = {
  totalPages: 1,
  processedPages: 1,
  segments: 2,
  translated: 2,
  untranslated: 0,
  batches: 1,
  durationMs: 5,
  fontPath: '/fake/font.ttf',
};

function makeTranslator() {
  const translate = vi.fn(
    async (
      _data: Uint8Array,
      _opts: { signal: AbortSignal; onProgress?: (m: string) => void; pages?: number[] },
    ) => ({
      outputBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      stats: fakeStats,
    }),
  );
  return {
    translator: { translate } as unknown as PdfTranslator,
    translate,
  };
}

describe('parsePageRange', () => {
  it('parses single pages, ranges and lists', () => {
    expect(parsePageRange('3')).toEqual([3]);
    expect(parsePageRange('1-3')).toEqual([1, 2, 3]);
    expect(parsePageRange('1-2,5')).toEqual([1, 2, 5]);
    expect(parsePageRange('2,2,1')).toEqual([1, 2]); // 去重升序
  });

  it('rejects invalid input', () => {
    expect(parsePageRange('')).toBeNull();
    expect(parsePageRange('abc')).toBeNull();
    expect(parsePageRange('5-1')).toBeNull();
    expect(parsePageRange('0')).toBeNull();
    expect(parsePageRange('1-2,')).toBeNull();
  });
});

describe('TranslatePdfTool', () => {
  it('rejects empty file_path', async () => {
    const tool = new TranslatePdfTool();
    const r = await tool.execute({ file_path: '' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects invalid page_range', async () => {
    const { translator } = makeTranslator();
    const tool = new TranslatePdfTool({ getTranslator: () => translator });
    const r = await tool.execute({ file_path: 'doc.pdf', page_range: 'abc' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects missing file', async () => {
    const tool = new TranslatePdfTool();
    const r = await tool.execute({ file_path: 'nope.pdf' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_PATH_INVALID);
  });

  it('rejects non-PDF files', async () => {
    const tool = new TranslatePdfTool();
    const r = await tool.execute({ file_path: 'note.txt' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
    expect(r.content).toContain('PDF');
  });

  it('rejects paths outside the workspace', async () => {
    const outside = path.join(os.tmpdir(), 'outside-translate.pdf');
    await fs.writeFile(outside, '%PDF-1.4 outside');
    try {
      const tool = new TranslatePdfTool();
      const r = await tool.execute({ file_path: outside }, ctx());
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_PERMISSION_DENIED);
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it('fails when translator dependency is missing', async () => {
    const tool = new TranslatePdfTool();
    const r = await tool.execute({ file_path: 'doc.pdf' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toContain('翻译功能不可用');
  });

  it('writes default <name>.zh.pdf output and reports stats', async () => {
    const { translator, translate } = makeTranslator();
    const tool = new TranslatePdfTool({ getTranslator: () => translator });

    const r = await tool.execute({ file_path: 'a.pdf' }, ctx());

    expect(r.ok).toBe(true);
    expect(r.display?.outputPath).toBe('a.zh.pdf');
    expect(r.content).toContain('a.zh.pdf');
    const written = await fs.readFile(path.join(root, 'a.zh.pdf'));
    expect(written.length).toBe(4);
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('refuses to overwrite existing output unless overwrite=true', async () => {
    const { translator } = makeTranslator();
    const tool = new TranslatePdfTool({ getTranslator: () => translator });
    await fs.writeFile(path.join(root, 'b.zh.pdf'), 'old');

    const refused = await tool.execute({ file_path: 'b.pdf' }, ctx());
    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('已存在');

    const overwritten = await tool.execute({ file_path: 'b.pdf', overwrite: true }, ctx());
    expect(overwritten.ok).toBe(true);
    const written = await fs.readFile(path.join(root, 'b.zh.pdf'));
    expect(written.length).toBe(4);
  });

  it('passes parsed page range to the translator', async () => {
    const { translator, translate } = makeTranslator();
    const tool = new TranslatePdfTool({ getTranslator: () => translator });

    const r = await tool.execute({ file_path: 'doc.pdf', page_range: '1-2' }, ctx());

    expect(r.ok).toBe(true);
    const opts = translate.mock.calls[0]![1];
    expect(opts.pages).toEqual([1, 2]);
  });

  it('maps PdfTranslateError codes to user-readable failures', async () => {
    const translator = {
      translate: vi.fn(async () => {
        throw new PdfTranslateError('no-text-layer', 'no layer');
      }),
    } as unknown as PdfTranslator;
    const tool = new TranslatePdfTool({ getTranslator: () => translator });

    // c.pdf 专用于本用例（其默认输出 c.zh.pdf 不会与其它用例冲突）
    const r = await tool.execute({ file_path: 'c.pdf' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toContain('扫描件');
  });

  it('returns aborted error when signal is cancelled', async () => {
    const translator = {
      translate: vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    } as unknown as PdfTranslator;
    const tool = new TranslatePdfTool({ getTranslator: () => translator });

    // c.pdf 专用于本用例（translator 抛出但未写盘，不影响其它用例）
    const r = await tool.execute({ file_path: 'c.pdf' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TASK_LOOP_ABORTED);
  });
});
