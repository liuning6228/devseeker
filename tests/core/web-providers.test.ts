/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * TavilyProvider / BochaProvider 单测（W6b3）
 *
 * 覆盖：
 * - 请求参数映射（topK 上限 / site / timeRange）
 * - 响应映射到 SearchResultItem
 * - 非 2xx 响应 → 空结果 + tookMs
 * - 网络错误 → 空结果
 * - probe 行为
 */

import { describe, it, expect, vi } from 'vitest';
import { TavilyProvider } from '../../src/core/web/tavily.js';
import { BochaProvider } from '../../src/core/web/bocha.js';
import type { FetchImpl } from '../../src/core/web/types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TavilyProvider', () => {
  it('maps request parameters correctly', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.api_key).toBe('tvly-xxx');
      expect(body.query).toBe('react hooks site:reactjs.org');
      expect(body.max_results).toBe(10); // 上限
      expect(body.time_range).toBe('year');
      return jsonResponse({ results: [] });
    }) as unknown as FetchImpl;

    const p = new TavilyProvider({ apiKey: 'tvly-xxx', fetchImpl });
    await p.search({
      query: 'react hooks',
      topK: 99,
      timeRange: 'OneYear',
      site: 'reactjs.org',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('maps response items', async () => {
    const fetchImpl: FetchImpl = async () =>
      jsonResponse({
        results: [
          {
            title: 'T1',
            url: 'https://a.com',
            content: 'snippet one',
            score: 0.9,
            published_date: '2025-01-01',
          },
          { title: 'T2', url: 'https://b.com', content: 'snippet two' },
        ],
      });

    const p = new TavilyProvider({ apiKey: 'k', fetchImpl });
    const r = await p.search({ query: 'x' });
    expect(r.provider).toBe('tavily');
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toMatchObject({
      title: 'T1',
      url: 'https://a.com',
      snippet: 'snippet one',
      score: 0.9,
      publishedAt: '2025-01-01',
    });
  });

  it('returns empty on non-2xx', async () => {
    const fetchImpl: FetchImpl = async () =>
      new Response('unauthorized', { status: 401 });
    const p = new TavilyProvider({ apiKey: 'bad', fetchImpl });
    const r = await p.search({ query: 'x' });
    expect(r.results).toEqual([]);
    expect(r.provider).toBe('tavily');
  });

  it('returns empty on network error', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error('ENETUNREACH');
    };
    const p = new TavilyProvider({ apiKey: 'k', fetchImpl });
    const r = await p.search({ query: 'x' });
    expect(r.results).toEqual([]);
  });

  it('probe returns ok=false when no key', async () => {
    const p = new TavilyProvider({ apiKey: '' });
    const r = await p.probe();
    expect(r.ok).toBe(false);
  });
});

describe('BochaProvider', () => {
  it('sends Authorization header + maps freshness', async () => {
    const fetchImpl = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      const hdrs = init?.headers as Record<string, string>;
      expect(hdrs.Authorization).toBe('Bearer sk-bocha');
      const body = JSON.parse(String(init?.body));
      expect(body.query).toBe('鸿蒙');
      expect(body.count).toBe(3);
      expect(body.freshness).toBe('oneMonth');
      return jsonResponse({ data: { webPages: { value: [] } } });
    }) as unknown as FetchImpl;

    const p = new BochaProvider({ apiKey: 'sk-bocha', fetchImpl });
    await p.search({ query: '鸿蒙', topK: 3, timeRange: 'OneMonth' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('maps nested webPages.value', async () => {
    const fetchImpl: FetchImpl = async () =>
      jsonResponse({
        data: {
          webPages: {
            value: [
              {
                name: '博查标题',
                url: 'https://a.cn',
                summary: '博查摘要',
                datePublished: '2025-02-01',
              },
            ],
          },
        },
      });
    const p = new BochaProvider({ apiKey: 'k', fetchImpl });
    const r = await p.search({ query: '测试' });
    expect(r.provider).toBe('bocha');
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({
      title: '博查标题',
      url: 'https://a.cn',
      snippet: '博查摘要',
      publishedAt: '2025-02-01',
    });
  });

  it('returns empty on non-2xx', async () => {
    const fetchImpl: FetchImpl = async () => new Response('', { status: 500 });
    const p = new BochaProvider({ apiKey: 'k', fetchImpl });
    const r = await p.search({ query: 'x' });
    expect(r.results).toEqual([]);
  });
});
