/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Bing + DuckDuckGo provider 测试（W8.11）
 */

import { describe, it, expect, vi } from 'vitest';
import { BingProvider } from '../../src/core/web/bing.js';
import {
  DuckDuckGoProvider,
  parseDdgHtml,
} from '../../src/core/web/duckduckgo.js';
import type { FetchImpl } from '../../src/core/web/types.js';

describe('BingProvider', () => {
  it('sends Ocp-Apim-Subscription-Key header + mkt + count', async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Headers | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          webPages: {
            value: [
              {
                name: 'Bing Result One',
                url: 'https://example.com/a',
                snippet: 'Snippet A',
                dateLastCrawled: '2026-04-01',
              },
              {
                name: 'Bing Result Two',
                url: 'https://example.com/b',
                snippet: 'Snippet B',
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as FetchImpl;

    const p = new BingProvider({ apiKey: 'KEY123', fetchImpl });
    const r = await p.search({ query: 'hello 世界', topK: 2, language: 'zh' });
    expect(r.provider).toBe('bing');
    expect(r.results).toHaveLength(2);
    expect(r.results[0]!.title).toBe('Bing Result One');
    expect(r.results[0]!.url).toBe('https://example.com/a');
    expect(r.results[0]!.publishedAt).toBe('2026-04-01');

    expect(capturedUrl).toContain('q=hello+');
    expect(capturedUrl).toContain('count=2');
    expect(capturedUrl).toContain('mkt=zh-CN');
    expect(capturedHeaders?.get('Ocp-Apim-Subscription-Key')).toBe('KEY123');
  });

  it('maps freshness correctly', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response('{"webPages":{"value":[]}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as FetchImpl;
    const p = new BingProvider({ apiKey: 'k', fetchImpl });
    await p.search({ query: 'a', timeRange: 'OneDay' });
    await p.search({ query: 'a', timeRange: 'OneWeek' });
    await p.search({ query: 'a', timeRange: 'OneMonth' });
    await p.search({ query: 'a', timeRange: 'OneYear' }); // no mapping → omitted
    expect(urls[0]).toContain('freshness=Day');
    expect(urls[1]).toContain('freshness=Week');
    expect(urls[2]).toContain('freshness=Month');
    expect(urls[3]).not.toContain('freshness=');
  });

  it('applies site: filter', async () => {
    let capturedUrl = '';
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response('{"webPages":{"value":[]}}', { status: 200 });
    }) as FetchImpl;
    const p = new BingProvider({ apiKey: 'k', fetchImpl });
    await p.search({ query: 'docs', site: 'example.com' });
    expect(decodeURIComponent(capturedUrl)).toContain('site:example.com');
  });

  it('returns empty on non-200', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 401 })) as FetchImpl;
    const p = new BingProvider({ apiKey: 'k', fetchImpl });
    const r = await p.search({ query: 'x' });
    expect(r.results).toEqual([]);
  });

  it('probe returns ok=false when apiKey missing', async () => {
    const p = new BingProvider({ apiKey: '', fetchImpl: vi.fn() as unknown as FetchImpl });
    const r = await p.probe();
    expect(r.ok).toBe(false);
  });
});

describe('parseDdgHtml', () => {
  it('extracts title/url/snippet from uddg links', () => {
    const html = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">Example Site</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">This is the <b>first</b> snippet</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsecond.example%2Fpage">Second Result</a>
  <a class="result__snippet" href="#">Snippet two</a>
</div>`;
    const items = parseDdgHtml(html, 10);
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe('Example Site');
    expect(items[0]!.url).toBe('https://example.com/a');
    expect(items[0]!.snippet).toContain('first snippet');
    expect(items[1]!.url).toBe('https://second.example/page');
  });

  it('respects topK', () => {
    const block = (n: number) => `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fex${n}.com">T${n}</a>
<a class="result__snippet">S${n}</a>`;
    const html = [1, 2, 3, 4, 5].map(block).join('\n');
    expect(parseDdgHtml(html, 3)).toHaveLength(3);
  });

  it('skips results without resolvable url', () => {
    const html = `
<a class="result__a" href="#">Bad</a>
<a class="result__snippet">X</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgood.com">Good</a>
<a class="result__snippet">Y</a>`;
    const items = parseDdgHtml(html, 10);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Good');
  });
});

describe('DuckDuckGoProvider', () => {
  it('posts to DDG HTML endpoint and parses results', async () => {
    let capturedBody = '';
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      return new Response(
        `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fex.com">Title X</a><a class="result__snippet">Snip X</a>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }) as FetchImpl;
    const p = new DuckDuckGoProvider({ fetchImpl });
    const r = await p.search({ query: 'test query', topK: 3 });
    expect(r.provider).toBe('duckduckgo');
    expect(r.results).toHaveLength(1);
    expect(r.results[0]!.title).toBe('Title X');
    expect(r.results[0]!.url).toBe('https://ex.com');
    expect(capturedBody).toContain('q=test+query');
  });

  it('maps timeRange to df parameter', async () => {
    let capturedBody = '';
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      return new Response('', { status: 200 });
    }) as FetchImpl;
    const p = new DuckDuckGoProvider({ fetchImpl });
    await p.search({ query: 'x', timeRange: 'OneWeek' });
    expect(capturedBody).toContain('df=w');
  });

  it('does NOT require API key', () => {
    const p = new DuckDuckGoProvider();
    expect(p.requiresKey).toBe(false);
  });

  it('returns empty on network failure', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as FetchImpl;
    const p = new DuckDuckGoProvider({ fetchImpl });
    const r = await p.search({ query: 'x' });
    expect(r.results).toEqual([]);
  });
});
