/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * tests/core/ollama-embedder.test.ts
 *
 * M4-Ollama · OllamaEmbedder 测试
 *
 * 覆盖：
 * - OllamaEmbedder.embed 单文本
 * - OllamaEmbedder.embed 多文本分批
 * - OllamaEmbedder.embed 空数组
 * - OllamaEmbedder.embed 超时
 * - OllamaEmbedder.embed HTTP 错误
 * - OllamaEmbedder.probe 在线/离线
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaEmbedder } from '../../src/core/index/embedder.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

describe('OllamaEmbedder', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('单文本返回 768 维向量', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({
        embedding: new Array(768).fill(0.5),
        prompt_eval_count: 10,
      })),
    );
    const e = new OllamaEmbedder({ fetchImpl: fetchMock });
    const r = await e.embed(['hello world']);
    expect(r.vectors.length).toBe(1);
    expect(r.vectors[0].length).toBe(768);
    expect(r.totalTokens).toBe(10);
  });

  it('多文本分批（batchSize=2 时 3 条分 2 批调用）', async () => {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ embedding: new Array(768).fill(0.5), prompt_eval_count: 5 }),
    ));
    const e = new OllamaEmbedder({ fetchImpl: fetchMock, batchSize: 2 });
    const r = await e.embed(['a', 'b', 'c']);
    expect(r.vectors.length).toBe(3);
    // batch 1 并发 2 条 + batch 2 并发 1 条 = 共 3 次调用（Ollama API 单条 prompt）
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('空数组返回空', async () => {
    const e = new OllamaEmbedder({ fetchImpl: fetchMock });
    const r = await e.embed([]);
    expect(r.vectors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('超时抛 INDEX_EMBED_TIMEOUT', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
    const e = new OllamaEmbedder({ fetchImpl: fetchMock, timeoutMs: 100 });
    await expect(e.embed(['hello'])).rejects.toMatchObject({
      code: ErrorCodes.INDEX_EMBED_TIMEOUT,
    });
  });

  it('HTTP 500 抛 INDEX_EMBEDDER_UNAVAILABLE', async () => {
    fetchMock.mockResolvedValue(new Response('Internal Error', { status: 500 }));
    const e = new OllamaEmbedder({ fetchImpl: fetchMock });
    await expect(e.embed(['hello'])).rejects.toMatchObject({
      code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
    });
  });

  it('probe 返回 true 当 Ollama 在线', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text' }] })),
    );
    const e = new OllamaEmbedder({ fetchImpl: fetchMock });
    const ok = await e.probe();
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/tags'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('probe 返回 false 当 Ollama 不可达', async () => {
    fetchMock.mockRejectedValue(new Error('Connection refused'));
    const e = new OllamaEmbedder({ fetchImpl: fetchMock });
    const ok = await e.probe();
    expect(ok).toBe(false);
  });

  it('默认配置使用正确的 URL 和模型名', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ embedding: new Array(768).fill(0.1) })),
    );
    const e = new OllamaEmbedder({ fetchImpl: fetchMock });
    await e.embed(['test']);
    const callUrl = fetchMock.mock.calls[0][0];
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callUrl).toBe('http://127.0.0.1:11434/api/embeddings');
    expect(callBody.model).toBe('nomic-embed-text');
    expect(callBody.prompt).toBe('test');
  });

  it('dimension 属性正确', () => {
    const e = new OllamaEmbedder({ dimension: 768 });
    expect(e.dimension).toBe(768);
    expect(e.modelId).toBe('nomic-embed-text');
  });

  it('自定义配置生效', () => {
    const e = new OllamaEmbedder({
      baseUrl: 'http://localhost:11435',
      model: 'mxbai-embed-large',
      dimension: 1024,
      batchSize: 2,
      timeoutMs: 5000,
      fetchImpl: fetchMock,
    });
    expect(e.dimension).toBe(1024);
    expect(e.modelId).toBe('mxbai-embed-large');
  });
});
