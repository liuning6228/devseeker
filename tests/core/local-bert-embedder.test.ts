/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * LocalBertEmbedder embed() 核心分支单测（mock extractor）
 *
 * 不覆盖 static create()：那部分依赖真实 @huggingface/transformers + ONNX WASM + 模型文件，
 * 单测环境代价过高；改在手测阶段通过 Extension Development Host 验证真模型链路。
 *
 * 本测试通过 `Object.create(LocalBertEmbedder.prototype)` 绕过 private constructor，
 * 注入 mock extractor 来驱动 embed() 的全部分支：
 *   - kind 默认 = 'passage'，前缀 "passage: "
 *   - kind = 'query'，前缀 "query: "
 *   - Tensor.tolist() 分支
 *   - 直接二维数组分支
 *   - 空输入短路
 *   - extractor 抛错 → AgentError(INDEX_PARSE_FAIL)
 *   - 非预期返回结构 → AgentError(INDEX_PARSE_FAIL)
 *   - 条数不匹配 → AgentError(INDEX_PARSE_FAIL)
 *   - 维度不匹配 → AgentError(INDEX_PARSE_FAIL)
 */

import { describe, it, expect, vi } from 'vitest';
import { LocalBertEmbedder } from '../../src/core/index/local-bert-embedder.js';
import { AgentError, ErrorCodes } from '../../src/core/errors/index.js';

/**
 * 构造一个绕过 create() 的 LocalBertEmbedder 实例，注入 mock extractor。
 * 使用 Object.create 是为了避开 private constructor，不污染生产代码。
 */
function makeEmbedderWithMock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockExtractor: (inputs: string[], opts?: Record<string, unknown>) => Promise<any>,
  dimension = 4,
  modelId = 'Xenova/multilingual-e5-small',
): LocalBertEmbedder {
  const inst = Object.create(LocalBertEmbedder.prototype) as LocalBertEmbedder & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractor: any;
    dimension: number;
    modelId: string;
  };
  inst.dimension = dimension;
  inst.modelId = modelId;
  inst.extractor = mockExtractor;
  return inst;
}

describe('LocalBertEmbedder.embed', () => {
  it('returns empty for empty input (short-circuit, extractor not called)', async () => {
    const extractor = vi.fn();
    const embedder = makeEmbedderWithMock(extractor);
    const r = await embedder.embed([]);
    expect(r.vectors).toEqual([]);
    expect(extractor).not.toHaveBeenCalled();
  });

  it('defaults kind to "passage" (prefix "passage: ")', async () => {
    const extractor = vi.fn().mockResolvedValue({
      tolist: () => [[1, 0, 0, 0]],
    });
    const embedder = makeEmbedderWithMock(extractor);
    await embedder.embed(['hello']);
    expect(extractor).toHaveBeenCalledTimes(1);
    const [inputs, opts] = extractor.mock.calls[0];
    expect(inputs).toEqual(['passage: hello']);
    expect(opts).toMatchObject({ pooling: 'mean', normalize: true });
  });

  it('uses "query: " prefix when kind = "query"', async () => {
    const extractor = vi.fn().mockResolvedValue({
      tolist: () => [[0, 1, 0, 0]],
    });
    const embedder = makeEmbedderWithMock(extractor);
    await embedder.embed(['find bug'], { kind: 'query' });
    const [inputs] = extractor.mock.calls[0];
    expect(inputs).toEqual(['query: find bug']);
  });

  it('unwraps Tensor via tolist()', async () => {
    const extractor = vi.fn().mockResolvedValue({
      tolist: () => [
        [0.1, 0.2, 0.3, 0.4],
        [0.5, 0.6, 0.7, 0.8],
      ],
    });
    const embedder = makeEmbedderWithMock(extractor);
    const r = await embedder.embed(['a', 'b']);
    expect(r.vectors).toEqual([
      [0.1, 0.2, 0.3, 0.4],
      [0.5, 0.6, 0.7, 0.8],
    ]);
  });

  it('accepts plain 2-D array return (fallback for transformers versions w/o Tensor)', async () => {
    const extractor = vi.fn().mockResolvedValue([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    const embedder = makeEmbedderWithMock(extractor);
    const r = await embedder.embed(['x', 'y']);
    expect(r.vectors).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
  });

  it('wraps extractor exception into AgentError(INDEX_PARSE_FAIL)', async () => {
    const extractor = vi.fn().mockRejectedValue(new Error('WASM crashed'));
    const embedder = makeEmbedderWithMock(extractor);
    await expect(embedder.embed(['oops'])).rejects.toMatchObject({
      code: ErrorCodes.INDEX_PARSE_FAIL,
    });
  });

  it('throws INDEX_PARSE_FAIL on unexpected return shape', async () => {
    const extractor = vi.fn().mockResolvedValue({ weird: true });
    const embedder = makeEmbedderWithMock(extractor);
    await expect(embedder.embed(['x'])).rejects.toBeInstanceOf(AgentError);
  });

  it('throws when vector count mismatches input count', async () => {
    const extractor = vi.fn().mockResolvedValue({
      tolist: () => [[1, 2, 3, 4]], // 1 条
    });
    const embedder = makeEmbedderWithMock(extractor);
    await expect(embedder.embed(['a', 'b'])).rejects.toMatchObject({
      code: ErrorCodes.INDEX_PARSE_FAIL,
    });
  });

  it('throws when vector dimension mismatches declared dim', async () => {
    const extractor = vi.fn().mockResolvedValue({
      tolist: () => [[1, 2, 3]], // 3 维，期望 4
    });
    const embedder = makeEmbedderWithMock(extractor, 4);
    await expect(embedder.embed(['x'])).rejects.toMatchObject({
      code: ErrorCodes.INDEX_PARSE_FAIL,
    });
  });

  it('exposes modelId and dimension from constructor inputs', () => {
    const embedder = makeEmbedderWithMock(vi.fn(), 384, 'Xenova/multilingual-e5-small');
    expect(embedder.dimension).toBe(384);
    expect(embedder.modelId).toBe('Xenova/multilingual-e5-small');
  });
});
