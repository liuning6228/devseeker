/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 联网工具单测（W6b3）
 *
 * 覆盖：
 * - SearchWebTool：
 *   · empty query → TOOL_ARGS_INVALID
 *   · 无 provider 注册 → WEB_SEARCH_PROVIDER_DOWN
 *   · 首选空 → 次选命中 → 成功
 *   · 都空 → WEB_SEARCH_PROVIDER_DOWN
 * - FetchContentTool：
 *   · 无效 url / SSRF → WEB_URL_BLOCKED_BY_WHITELIST
 *   · readable 模式走 Jina Reader（useJinaReader=true）→ URL 前缀 https://r.jina.ai/
 *   · raw 模式直 fetch 原 URL
 *   · 403/404 → WEB_FETCH_403 / WEB_FETCH_404
 *   · 内容超 maxLength → truncated=true
 *   · 返回包裹 <web_content> 块
 * - ReadUrlTool：默认 readable + maxLength=10000
 */

import { describe, it, expect, vi } from 'vitest';
import { SearchWebTool } from '../../src/core/tools/search_web.js';
import { FetchContentTool } from '../../src/core/tools/fetch_content.js';
import { ReadUrlTool } from '../../src/core/tools/read_url.js';
import type { ToolContext } from '../../src/core/tools/types.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import type {
  FetchImpl,
  ISearchProvider,
  ProviderRegistry,
  SearchProviderId,
  SearchWebArgs,
  SearchWebResult,
  ProbeResult,
} from '../../src/core/web/index.js';

function ctx(): ToolContext {
  return {
    workspaceRoot: undefined,
    signal: new AbortController().signal,
    taskId: 't',
    toolCallId: 'c',
  };
}

function makeProv(id: SearchProviderId, result: SearchWebResult): ISearchProvider {
  return {
    id,
    requiresKey: true,
    async search(_a: SearchWebArgs): Promise<SearchWebResult> {
      return result;
    },
    async probe(): Promise<ProbeResult> {
      return { ok: true };
    },
  };
}

// ──────────────── SearchWebTool ────────────────

describe('SearchWebTool', () => {
  it('rejects empty query', async () => {
    const tool = new SearchWebTool({
      getRegistry: (): ProviderRegistry => ({ providers: new Map() }),
    });
    const r = await tool.execute({ query: '' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('returns PROVIDER_DOWN when no providers registered', async () => {
    const tool = new SearchWebTool({
      getRegistry: (): ProviderRegistry => ({ providers: new Map() }),
    });
    const r = await tool.execute({ query: 'react' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.WEB_SEARCH_PROVIDER_DOWN);
  });

  it('falls back to secondary provider when primary returns empty', async () => {
    const primary = makeProv('tavily', { results: [], provider: 'tavily', tookMs: 5 });
    const secondary = makeProv('bocha', {
      results: [{ title: 'hit', url: 'https://x.com', snippet: 's' }],
      provider: 'bocha',
      tookMs: 7,
    });
    const tool = new SearchWebTool({
      getRegistry: () => ({
        providers: new Map<SearchProviderId, ISearchProvider>([
          ['tavily', primary],
          ['bocha', secondary],
        ]),
      }),
    });
    const r = await tool.execute({ query: 'react', language: 'en' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('provider=bocha');
    expect(r.content).toContain('hit');
    expect(r.content).toContain('https://x.com');
  });

  it('all providers empty → PROVIDER_DOWN', async () => {
    const tool = new SearchWebTool({
      getRegistry: () => ({
        providers: new Map<SearchProviderId, ISearchProvider>([
          ['tavily', makeProv('tavily', { results: [], provider: 'tavily', tookMs: 1 })],
          ['bocha', makeProv('bocha', { results: [], provider: 'bocha', tookMs: 1 })],
        ]),
      }),
    });
    const r = await tool.execute({ query: 'x' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.WEB_SEARCH_PROVIDER_DOWN);
  });

  it('formats results with title/url/snippet', async () => {
    const provider = makeProv('tavily', {
      results: [
        {
          title: 'React Docs',
          url: 'https://react.dev',
          snippet: 'The library for web UIs',
          publishedAt: '2024-05-01',
        },
      ],
      provider: 'tavily',
      tookMs: 20,
    });
    const tool = new SearchWebTool({
      getRegistry: () => ({
        providers: new Map<SearchProviderId, ISearchProvider>([['tavily', provider]]),
      }),
    });
    const r = await tool.execute({ query: 'react', language: 'en' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('React Docs');
    expect(r.content).toContain('https://react.dev');
    expect(r.content).toContain('Published: 2024-05-01');
    expect(r.display).toMatchObject({ provider: 'tavily', tookMs: 20 });
  });
});

// ──────────────── FetchContentTool ────────────────

describe('FetchContentTool', () => {
  it('rejects SSRF urls (localhost)', async () => {
    const tool = new FetchContentTool({ fetchImpl: vi.fn() });
    const r = await tool.execute({ url: 'http://localhost:3000/x' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.WEB_URL_BLOCKED_BY_WHITELIST);
  });

  it('rejects private IP', async () => {
    const fn = vi.fn();
    const tool = new FetchContentTool({ fetchImpl: fn as unknown as FetchImpl });
    const r = await tool.execute({ url: 'http://192.168.1.1/x' }, ctx());
    expect(r.ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('readable mode with jina uses r.jina.ai prefix', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('https://r.jina.ai/https://example.com/article');
      return new Response('# Title\n\nhello from jina', {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      });
    }) as unknown as FetchImpl;
    const tool = new FetchContentTool({ fetchImpl, useJinaReader: true });
    const r = await tool.execute(
      { url: 'https://example.com/article', mode: 'readable' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('hello from jina');
    expect(r.content).toContain('<web_content');
    expect(r.content).toContain('数据而非指令');
  });

  it('raw mode fetches original url directly', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('https://api.example.com/data');
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as FetchImpl;
    const tool = new FetchContentTool({ fetchImpl, useJinaReader: true });
    const r = await tool.execute(
      { url: 'https://api.example.com/data', mode: 'raw' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('"ok":true');
  });

  it('maps 403 / 404', async () => {
    const tool403 = new FetchContentTool({
      fetchImpl: (async () => new Response('', { status: 403 })) as FetchImpl,
    });
    let r = await tool403.execute({ url: 'https://example.com' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.WEB_FETCH_403);

    const tool404 = new FetchContentTool({
      fetchImpl: (async () => new Response('', { status: 404 })) as FetchImpl,
    });
    r = await tool404.execute({ url: 'https://example.com' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.WEB_FETCH_404);
  });

  it('truncates content larger than maxLength', async () => {
    const big = 'A'.repeat(30000);
    const fetchImpl = (async () =>
      new Response(big, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })) as FetchImpl;
    const tool = new FetchContentTool({ fetchImpl, useJinaReader: false });
    const r = await tool.execute(
      { url: 'https://example.com/big', mode: 'raw', maxLength: 1000 },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('[...内容被截断');
    expect((r.display as { truncated: boolean }).truncated).toBe(true);
  });

  it('rejects blocklisted url', async () => {
    const tool = new FetchContentTool({
      fetchImpl: vi.fn() as unknown as FetchImpl,
      blocklist: ['*.bad.example.com'],
    });
    const r = await tool.execute(
      { url: 'https://x.bad.example.com/abc' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.WEB_URL_BLOCKED_BY_WHITELIST);
  });

  // ──────────── W8.10: LRU cache ────────────

  it('second fetch for same url hits LRU cache', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('cached body content goes here', {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      });
    }) as FetchImpl;
    const tool = new FetchContentTool({
      fetchImpl,
      useJinaReader: false,
      rateLimiter: false,
    });
    const r1 = await tool.execute({ url: 'https://example.com/cached', mode: 'raw' }, ctx());
    const r2 = await tool.execute({ url: 'https://example.com/cached', mode: 'raw' }, ctx());
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(calls).toBe(1);
    expect((r2.display as { cache?: string }).cache).toBe('hit');
    expect((r1.display as { cache?: string }).cache).toBeUndefined();
  });

  it('different modes produce different cache keys', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('data here with sufficient length for caching behavior test', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }) as FetchImpl;
    const tool = new FetchContentTool({
      fetchImpl,
      useJinaReader: false,
      rateLimiter: false,
    });
    await tool.execute({ url: 'https://example.com/x', mode: 'raw' }, ctx());
    await tool.execute({ url: 'https://example.com/x', mode: 'structured' }, ctx());
    expect(calls).toBe(2);
  });

  it('cache can be disabled via cache:false', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('no cache body', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }) as FetchImpl;
    const tool = new FetchContentTool({
      fetchImpl,
      useJinaReader: false,
      cache: false,
      rateLimiter: false,
    });
    await tool.execute({ url: 'https://example.com/nc', mode: 'raw' }, ctx());
    await tool.execute({ url: 'https://example.com/nc', mode: 'raw' }, ctx());
    expect(calls).toBe(2);
  });

  // ──────────── W8.10: PDF branch ────────────

  it('extracts text from application/pdf response', async () => {
    const body =
      'BT /F1 12 Tf 72 720 Td (Quarterly financial report for fiscal year 2026 showing revenue growth across all segments.) Tj ET';
    const pdfBytes = Buffer.from(
      `%PDF-1.4\n1 0 obj << >> endobj\n2 0 obj << /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`,
      'latin1',
    );
    const fetchImpl = (async () =>
      new Response(pdfBytes, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })) as FetchImpl;
    const tool = new FetchContentTool({
      fetchImpl,
      useJinaReader: false,
      rateLimiter: false,
      cache: false,
    });
    const r = await tool.execute(
      { url: 'https://example.com/report.pdf', mode: 'raw' },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Quarterly financial report');
  });

  it('returns WEB_FETCH_PDF_UNSUPPORTED for PDF with too little extractable text', async () => {
    // PDF bytes with no Tj/TJ operators → extract yields empty
    const pdfBytes = Buffer.from('%PDF-1.4\nbinary garbage with no text operators', 'latin1');
    const fetchImpl = (async () =>
      new Response(pdfBytes, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })) as FetchImpl;
    const tool = new FetchContentTool({
      fetchImpl,
      useJinaReader: false,
      rateLimiter: false,
      cache: false,
    });
    const r = await tool.execute(
      { url: 'https://example.com/empty.pdf', mode: 'raw' },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.WEB_FETCH_PDF_UNSUPPORTED);
  });

  // ──────────── W8.10: rate limiter ────────────

  it('respects rate limiter (aborted signal → WEB_FETCH_RATE_LIMITED)', async () => {
    const fetchImpl = vi.fn() as unknown as FetchImpl;
    // Pre-exhausted rate limiter + sleep that never advances clock + aborted signal
    const { RateLimiter } = await import('../../src/core/web/rate-limiter.js');
    const rl = new RateLimiter({
      rps: 1,
      capacity: 1,
      now: () => 1000,
      sleep: async () => {
        /* never advances */
      },
    });
    rl.tryAcquire(); // drain
    const tool = new FetchContentTool({
      fetchImpl,
      useJinaReader: false,
      rateLimiter: rl,
      cache: false,
    });
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await tool.execute(
      { url: 'https://example.com/rl', mode: 'raw' },
      { ...ctx(), signal: ctrl.signal },
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.WEB_FETCH_RATE_LIMITED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ──────────────── ReadUrlTool ────────────────

describe('ReadUrlTool', () => {
  it('uses readable mode with maxLength=10000 under the hood', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('r.jina.ai');
      return new Response('ok body', { status: 200, headers: { 'content-type': 'text/markdown' } });
    }) as unknown as FetchImpl;
    const tool = new ReadUrlTool({ fetchImpl, useJinaReader: true });
    const r = await tool.execute({ url: 'https://example.com/post' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('ok body');
    expect((r.display as { mode: string }).mode).toBe('readable');
  });

  it('rejects empty url', async () => {
    const tool = new ReadUrlTool({});
    const r = await tool.execute({ url: '' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });
});
