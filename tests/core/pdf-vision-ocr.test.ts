/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * createVisionOcrRunner 单测
 *
 * 覆盖：
 * - provider 缺失 / 功能禁用 → null（不触发渲染）
 * - 逐页转录 + 分页聚合格式
 * - 单页失败隔离（error 事件 → 该页占位，继续下一页）
 * - 系统性故障保护（从未成功且连续 3 页失败 → 提前终止）
 * - 渲染跳过页计入失败页
 * - AbortSignal：预取消 / 中途取消
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createVisionOcrRunner,
  type VisionOcrConfig,
} from '../../src/core/pdf/vision-ocr.js';
import type { RenderedPdfPages } from '../../src/core/pdf/render.js';
import type { IProvider } from '../../src/providers/base.js';
import type { StreamEvent } from '../../src/providers/types.js';

const IMG = 'data:image/jpeg;base64,AAAA';

const baseConfig: VisionOcrConfig = { enabled: true, scale: 1, quality: 70, maxPages: 0 };

function okSignal(): AbortSignal {
  return new AbortController().signal;
}

/** 固定渲染结果（不触发真实 pdfjs） */
function fakeRender(pages: RenderedPdfPages) {
  return vi.fn(async () => pages);
}

/**
 * 构造 fake provider：按调用序号返回事件序列（或固定序列）。
 * 返回 provider 与 createMessage 调用参数列表。
 */
function makeFakeProvider(events: StreamEvent[] | ((callIndex: number) => StreamEvent[])) {
  const calls: Array<Record<string, unknown>> = [];
  const provider = {
    id: 'fake-vlm',
    capabilities: ['vision'],
    contextWindow: 32_000,
    pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'CNY' },
    createMessage(options: Record<string, unknown>) {
      const idx = calls.length;
      calls.push(options);
      const evs = typeof events === 'function' ? events(idx) : events;
      return (async function* () {
        for (const e of evs) yield e;
      })();
    },
    probe: async () => ({ ok: true, latencyMs: 1 }),
    countTokens: async () => 1,
    updateApiKey: () => undefined,
  };
  return { provider: provider as unknown as IProvider, calls };
}

function textStream(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', text },
    { type: 'done', reason: 'stop' },
  ];
}

function errorStream(message: string): StreamEvent[] {
  return [{ type: 'error', error: { code: 'PROVIDER_HTTP_400', message, retryable: false } }];
}

describe('createVisionOcrRunner', () => {
  it('returns null without a provider and never renders', async () => {
    const render = fakeRender({ pages: [IMG], totalPages: 1, skipped: [] });
    const runner = createVisionOcrRunner({
      getProvider: () => undefined,
      getConfig: () => baseConfig,
      renderPages: render,
    });

    const r = await runner.run(Buffer.from('x'), { signal: okSignal() });
    expect(r).toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  it('returns null when disabled', async () => {
    const render = fakeRender({ pages: [IMG], totalPages: 1, skipped: [] });
    const { provider } = makeFakeProvider(textStream('x'));
    const runner = createVisionOcrRunner({
      getProvider: () => provider,
      getConfig: () => ({ ...baseConfig, enabled: false }),
      renderPages: render,
    });

    const r = await runner.run(Buffer.from('x'), { signal: okSignal() });
    expect(r).toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  it('transcribes each page and aggregates with page markers', async () => {
    const render = fakeRender({ pages: [IMG, IMG], totalPages: 2, skipped: [] });
    const { provider, calls } = makeFakeProvider((i) => textStream(`page ${i + 1} text`));
    const runner = createVisionOcrRunner({
      getProvider: () => provider,
      getConfig: () => baseConfig,
      renderPages: render,
    });

    const r = await runner.run(Buffer.from('x'), { signal: okSignal() });

    expect(r).not.toBeNull();
    expect(r!.pages).toBe(2);
    expect(r!.failedPages).toEqual([]);
    expect(r!.text).toContain('--- Page 1 ---');
    expect(r!.text).toContain('page 1 text');
    expect(r!.text).toContain('--- Page 2 ---');
    expect(r!.text).toContain('page 2 text');
    expect(calls).toHaveLength(2);
  });

  it('isolates a single page failure and continues', async () => {
    const render = fakeRender({ pages: [IMG, IMG], totalPages: 2, skipped: [] });
    // 第 2 页（callIndex=1）失败，第 1 页成功
    const { provider } = makeFakeProvider((i) =>
      i === 1 ? errorStream('boom') : textStream('good content'),
    );
    const runner = createVisionOcrRunner({
      getProvider: () => provider,
      getConfig: () => baseConfig,
      renderPages: render,
    });

    const r = await runner.run(Buffer.from('x'), { signal: okSignal() });

    expect(r).not.toBeNull();
    expect(r!.pages).toBe(1);
    expect(r!.failedPages).toEqual([2]);
    expect(r!.text).toContain('good content');
    expect(r!.text).toContain('[Page 2: recognition failed]');
  });

  it('stops early after 3 consecutive failures with no success', async () => {
    const render = fakeRender({ pages: [IMG, IMG, IMG, IMG], totalPages: 4, skipped: [] });
    const { provider, calls } = makeFakeProvider(() => errorStream('always fail'));
    const runner = createVisionOcrRunner({
      getProvider: () => provider,
      getConfig: () => baseConfig,
      renderPages: render,
    });

    const r = await runner.run(Buffer.from('x'), { signal: okSignal() });

    expect(r).toBeNull();
    // 4 页中只请求了 3 次（第 3 次连续失败后提前终止）
    expect(calls).toHaveLength(3);
  });

  it('counts render-skipped pages as failed pages', async () => {
    const render = fakeRender({ pages: [IMG], totalPages: 2, skipped: [1] });
    const { provider } = makeFakeProvider(textStream('second page text'));
    const runner = createVisionOcrRunner({
      getProvider: () => provider,
      getConfig: () => baseConfig,
      renderPages: render,
    });

    const r = await runner.run(Buffer.from('x'), { signal: okSignal() });

    expect(r).not.toBeNull();
    expect(r!.failedPages).toEqual([1]);
    expect(r!.skippedRenderPages).toEqual([1]);
    expect(r!.text).toContain('[Page 1: recognition failed]');
    expect(r!.text).toContain('--- Page 2 ---');
    expect(r!.text).toContain('second page text');
  });

  it('rejects on a pre-aborted signal', async () => {
    const render = fakeRender({ pages: [IMG], totalPages: 1, skipped: [] });
    const { provider } = makeFakeProvider(textStream('x'));
    const runner = createVisionOcrRunner({
      getProvider: () => provider,
      getConfig: () => baseConfig,
      renderPages: render,
    });

    const controller = new AbortController();
    controller.abort();

    await expect(runner.run(Buffer.from('x'), { signal: controller.signal })).rejects.toThrow(
      /aborted/i,
    );
    expect(render).not.toHaveBeenCalled();
  });

  it('rejects when aborted mid-run', async () => {
    const render = fakeRender({ pages: [IMG, IMG], totalPages: 2, skipped: [] });
    const controller = new AbortController();
    const { provider } = makeFakeProvider(() => {
      // 第一次调用期间触发取消：第 2 页循环开始时检查到 abort → 抛出
      controller.abort();
      return textStream('partial');
    });
    const runner = createVisionOcrRunner({
      getProvider: () => provider,
      getConfig: () => baseConfig,
      renderPages: render,
    });

    await expect(runner.run(Buffer.from('x'), { signal: controller.signal })).rejects.toThrow(
      /aborted/i,
    );
  });
});
