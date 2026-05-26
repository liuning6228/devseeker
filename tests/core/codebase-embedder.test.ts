/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * DashScopeEmbedder 单测（mock fetch）
 */

import { describe, it, expect, vi } from 'vitest';
import { DashScopeEmbedder } from '../../src/core/index/embedder.js';
import { AgentError, ErrorCodes } from '../../src/core/errors/index.js';

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Headers(),
  } as unknown as Response;
}

describe('DashScopeEmbedder', () => {
  it('throws when apiKey missing', () => {
    // @ts-expect-error testing missing key
    expect(() => new DashScopeEmbedder({})).toThrow(AgentError);
  });

  it('returns empty for empty input', async () => {
    const embedder = new DashScopeEmbedder({
      apiKey: 'k',
      fetchImpl: vi.fn(),
    });
    const r = await embedder.embed([]);
    expect(r.vectors).toEqual([]);
  });

  it('calls DashScope endpoint and parses vectors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        data: [
          { embedding: [0.1, 0.2, 0.3], index: 0 },
          { embedding: [0.4, 0.5, 0.6], index: 1 },
        ],
        usage: { total_tokens: 10 },
      }),
    );
    const embedder = new DashScopeEmbedder({
      apiKey: 'sk-test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const r = await embedder.embed(['a', 'b']);
    expect(r.vectors).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(r.totalTokens).toBe(10);

    // 校验请求
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/embeddings');
    const init2 = init as RequestInit & { headers: Record<string, string> };
    expect(init2.method).toBe('POST');
    expect(init2.headers.Authorization).toBe('Bearer sk-test');
    const payload = JSON.parse(init2.body as string);
    expect(payload.model).toBe('text-embedding-v3');
    expect(payload.input).toEqual(['a', 'b']);
  });

  it('batches large input sets according to batchSize', async () => {
    const fetchMock = vi.fn();
    // 第一个批次 2 条
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        data: [
          { embedding: [0.1], index: 0 },
          { embedding: [0.2], index: 1 },
        ],
      }),
    );
    // 第二个批次 1 条
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        data: [{ embedding: [0.3], index: 0 }],
      }),
    );

    const embedder = new DashScopeEmbedder({
      apiKey: 'k',
      batchSize: 2,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const r = await embedder.embed(['a', 'b', 'c']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.vectors).toEqual([[0.1], [0.2], [0.3]]);
  });

  it('reorders vectors by index field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        data: [
          { embedding: [9], index: 2 },
          { embedding: [7], index: 0 },
          { embedding: [8], index: 1 },
        ],
      }),
    );
    const embedder = new DashScopeEmbedder({
      apiKey: 'k',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const r = await embedder.embed(['a', 'b', 'c']);
    expect(r.vectors).toEqual([[7], [8], [9]]);
  });

  it('throws RATE_LIMITED on HTTP 429', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ error: 'rl' }, 429));
    const embedder = new DashScopeEmbedder({
      apiKey: 'k',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(embedder.embed(['x'])).rejects.toMatchObject({
      code: ErrorCodes.INDEX_EMBED_RATE_LIMITED,
    });
  });

  it('throws INVALID_API_KEY on HTTP 401/403', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ error: 'auth' }, 401));
    const embedder = new DashScopeEmbedder({
      apiKey: 'k',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(embedder.embed(['x'])).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY,
    });
  });

  it('throws on server 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse('oops', 500));
    const embedder = new DashScopeEmbedder({
      apiKey: 'k',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const err = await embedder.embed(['x']).catch((e) => e);
    expect(err.code).toBe(ErrorCodes.PROVIDER_SERVER_5XX);
    expect(err.retryable).toBe(true);
  });

  it('throws PARSE_FAIL when data field missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ foo: 'bar' }));
    const embedder = new DashScopeEmbedder({
      apiKey: 'k',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(embedder.embed(['x'])).rejects.toMatchObject({
      code: ErrorCodes.INDEX_PARSE_FAIL,
    });
  });

  it('throws PARSE_FAIL when a vector is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        data: [{ embedding: [0.1], index: 0 }],
      }),
    );
    const embedder = new DashScopeEmbedder({
      apiKey: 'k',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    // 期望 2 条却只回 1
    await expect(embedder.embed(['a', 'b'])).rejects.toMatchObject({
      code: ErrorCodes.INDEX_PARSE_FAIL,
    });
  });

  it('uses custom baseUrl when given', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ data: [{ embedding: [1], index: 0 }] }));
    const embedder = new DashScopeEmbedder({
      apiKey: 'k',
      baseUrl: 'https://example.com/v1/',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await embedder.embed(['a']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/v1/embeddings');
  });

  // v1.0.2：timeout 纳入 retry 白名单
  it('retries once on timeout abort and succeeds', async () => {
    const fetchMock = vi.fn();
    // 第 1 次：模拟 AbortController.abort（后端识别为 TIMEOUT）
    fetchMock.mockRejectedValueOnce(new Error('The operation was aborted.'));
    // 第 2 次：重试成功
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        data: [{ embedding: [0.42], index: 0 }],
        usage: { total_tokens: 3 },
      }),
    );

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const embedder = new DashScopeEmbedder({
        apiKey: 'k',
        fetchImpl: fetchMock as unknown as typeof fetch,
      });
      const p = embedder.embed(['a']);
      // 跳过 retry 之间的 1s 退避
      await vi.advanceTimersByTimeAsync(1100);
      const r = await p;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(r.vectors).toEqual([[0.42]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws INDEX_EMBED_TIMEOUT after 2 consecutive timeouts', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('aborted'));
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const embedder = new DashScopeEmbedder({
        apiKey: 'k',
        fetchImpl: fetchMock as unknown as typeof fetch,
      });
      const p = embedder.embed(['a']).catch((e) => e);
      await vi.advanceTimersByTimeAsync(1100);
      const err = await p;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((err as AgentError).code).toBe(ErrorCodes.INDEX_EMBED_TIMEOUT);
    } finally {
      vi.useRealTimers();
    }
  });
});
