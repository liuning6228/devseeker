/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * LocalBertEmbedder —— 离线 BERT embedding 实现
 * ----------------------------------------------------------------
 * 基于 @huggingface/transformers v4（v1.4.0 起使用 onnxruntime-web WASM 后端）。
 *
 * 默认模型：Xenova/multilingual-e5-small（384 维，~118 MB 量化 ONNX，中英混合）
 *
 * e5 系列要求对 input 加前缀：
 *   - passage（入库）：`passage: <text>`
 *   - query（搜索）：`query: <text>`
 * 前缀错误会显著降低召回率。
 *
 * 性能历史：
 *   - v1.2.0：WASM 单线程（发现 5000 chunks 要 25min+，不可接受）
 *   - v1.2.2：WASM 多线程 + SIMD（8 chunks/s 预期）
 *   - v1.2.3：onnxruntime-node 原生 CPU EP（预期 50-100 chunks/s，10x WASM）
 *   - v1.4.0：回退到 onnxruntime-web WASM（消除 .node DLL 依赖，跨平台零安装报错）
 */

import * as os from 'node:os';
import type { Embedder, EmbedOptions, EmbedResult } from './embedder.js';
import { AgentError, ErrorCodes } from '../errors/index.js';

export interface LocalBertEmbedderConfig {
  /**
   * 模型根目录绝对路径。
   * 必须是包含 `<hfOrg>/<hfName>/` 子目录的**父**目录。
   * 例如：若模型文件在 `<ext>/models/Xenova/multilingual-e5-small/`，此处传 `<ext>/models`。
   */
  modelDir: string;
  /** 默认 'Xenova/multilingual-e5-small' */
  hfId?: string;
  /** 默认 384（multilingual-e5-small 原生维度） */
  dimension?: number;
}

const DEFAULT_HF_ID = 'Xenova/multilingual-e5-small';
const DEFAULT_DIM = 384;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FeatureExtractionPipeline = (inputs: string[], opts?: Record<string, unknown>) => Promise<any>;

export class LocalBertEmbedder implements Embedder {
  readonly dimension: number;
  readonly modelId: string;

  private readonly extractor: FeatureExtractionPipeline;

  private constructor(modelId: string, dimension: number, extractor: FeatureExtractionPipeline) {
    this.modelId = modelId;
    this.dimension = dimension;
    this.extractor = extractor;
  }

  /**
   * 懒加载：首次调用耗时 5-10s（模型 + tokenizer 读盘 + WASM 初始化）。
   * 建议上层做单例缓存。
   */
  static async create(cfg: LocalBertEmbedderConfig): Promise<LocalBertEmbedder> {
    const hfId = cfg.hfId ?? DEFAULT_HF_ID;
    const dimension = cfg.dimension ?? DEFAULT_DIM;
    if (!cfg.modelDir) {
      throw new AgentError({
        code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
        message: 'LocalBertEmbedder 缺少 modelDir',
      });
    }

    let pipeline: (...args: unknown[]) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let env: any;
    try {
      // 使用 require 确保加载 CommonJS 版本（transformers.node.cjs），
      // 该版本通过 require("onnxruntime-node") 正确加载原生后端
      // 避免 ESM 版本的静态 import 在 esbuild 打包环境中失败
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('@huggingface/transformers') as {
        pipeline: (...args: unknown[]) => Promise<unknown>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        env: any;
      };
      pipeline = mod.pipeline;
      env = mod.env;
    } catch (e) {
      throw new AgentError({
        code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
        message: `@huggingface/transformers 模块加载失败: ${(e as Error).message}`,
      });
    }

    // 强制本地模型路径，禁用远程下载（VSIX 已打包模型）
    env.localModelPath = cfg.modelDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    // v1.4.0 · 强制使用 onnxruntime-web WASM 后端
    // 使用 onnxruntime-node 原生后端（Node.js 环境下正常工作）
    // onnxruntime-node 已安装，transformers.js 会自动使用它
    if (env.backends?.onnx?.wasm) {
      const cores = Math.max(1, os.cpus().length || 2);
      env.backends.onnx.wasm.numThreads = Math.min(4, cores);
      env.backends.onnx.wasm.simd = true;
    }

    let extractor: FeatureExtractionPipeline;
    try {
      // dtype: 'q8' 对应 models/<hf>/onnx/model_quantized.onnx
      // 使用 onnxruntime-node 原生后端（Node.js 环境）
      extractor = (await pipeline('feature-extraction', hfId, {
        dtype: 'q8',
      })) as unknown as FeatureExtractionPipeline;
    } catch (e) {
      throw new AgentError({
        code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
        message: `本地 BERT 模型加载失败: ${(e as Error).message}`,
      });
    }

    return new LocalBertEmbedder(hfId, dimension, extractor);
  }

  async embed(inputs: string[], opts?: EmbedOptions): Promise<EmbedResult> {
    if (!inputs.length) return { vectors: [] };

    // e5 系列：passage 与 query 需区分前缀，否则召回质量显著下降
    const prefix = opts?.kind === 'query' ? 'query: ' : 'passage: ';
    const prefixed = inputs.map((s) => prefix + s);

    let out: { tolist?: () => number[][] } | number[][] | undefined;
    try {
      out = await this.extractor(prefixed, {
        pooling: 'mean',
        normalize: true,
      });
    } catch (e) {
      throw new AgentError({
        code: ErrorCodes.INDEX_PARSE_FAIL,
        message: `本地 embedding 推理失败: ${(e as Error).message}`,
      });
    }

    // transformers.js 返回 Tensor（有 tolist()）；不同版本直接返回二维数组也兜底
    let vectors: number[][];
    if (out && typeof (out as { tolist?: () => number[][] }).tolist === 'function') {
      vectors = (out as { tolist: () => number[][] }).tolist();
    } else if (Array.isArray(out)) {
      vectors = out as number[][];
    } else {
      throw new AgentError({
        code: ErrorCodes.INDEX_PARSE_FAIL,
        message: '本地 embedding 返回非预期结构',
      });
    }

    // 校验：vectors 长度与 inputs 一致、每个向量维度正确
    if (vectors.length !== inputs.length) {
      throw new AgentError({
        code: ErrorCodes.INDEX_PARSE_FAIL,
        message: `本地 embedding 输出条数不一致: got ${vectors.length} expect ${inputs.length}`,
      });
    }
    for (let i = 0; i < vectors.length; i++) {
      if (!Array.isArray(vectors[i]) || vectors[i].length !== this.dimension) {
        throw new AgentError({
          code: ErrorCodes.INDEX_PARSE_FAIL,
          message: `本地 embedding 第 ${i} 条维度不匹配: got ${vectors[i]?.length} expect ${this.dimension}`,
        });
      }
    }

    return { vectors };
  }
}
