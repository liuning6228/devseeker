/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Embedder 抽象 + 阿里云 DashScope text-embedding-v3 客户端 + Ollama 本地客户端
 *
 * 来源：Plan Task 4.3（方案 B 远程，text-embedding-v3）
 * M4-Ollama：新增 OllamaEmbedder（nomic-embed-text 768 维，本地零成本）
 *
 * DashScope embedding 兼容 OpenAI 协议：
 *   POST {baseUrl}/embeddings
 *   Body: { model, input: string | string[], encoding_format?: 'float' }
 *   Resp: { data: [{ embedding: number[], index }], usage: { total_tokens } }
 *
 * Ollama embedding：
 *   POST http://localhost:11434/api/embeddings
 *   Body: { model, prompt: string }
 *   Resp: { embedding: number[] }
 *
 * 默认：
 * - baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1
 * - model text-embedding-v3（1024 维）
 * - 批次 10（DashScope 2026-Q1 起将 text-embedding-v3 服务端上限从 25 收紧到 10；
 *   报错示例：`InvalidParameter: batch size is invalid, it should not be larger than 10.`）
 */

import { AgentError, ErrorCodes } from '../errors/index.js';

export interface EmbedResult {
  /** 与输入一一对应的向量 */
  vectors: number[][];
  /** 模型报告的 token 数（可选） */
  totalTokens?: number;
}

/**
 * Embedder 调用选项（v1.2.0 W13.4 引入）。
 *
 * 部分模型（如 multilingual-e5-*）区分 passage 与 query，需要在 input 前加前缀：
 *   - passage 场景（入库文档索引）：`passage: <text>`
 *   - query   场景（搜索时）：`query: <text>`
 *
 * DashScope / 其他不区分 passage/query 的实现可忽略此参数。
 */
export interface EmbedOptions {
  /** 默认 'passage' */
  kind?: 'passage' | 'query';
}

export interface Embedder {
  /** 向量维度 */
  readonly dimension: number;
  /** 模型标识（用于缓存键） */
  readonly modelId: string;
  embed(inputs: string[], opts?: EmbedOptions): Promise<EmbedResult>;
}

export interface DashScopeEmbedderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  dimension?: number;
  /** 单次请求最大条数；默认 25 */
  batchSize?: number;
  /** 超时毫秒；默认 60000（v1.0.2 从 30s 提升到 60s，给 DashScope 冷启动留空间） */
  timeoutMs?: number;
  /** 自定义 fetch（便于单测注入） */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'text-embedding-v3';
const DEFAULT_DIM = 1024;
const DEFAULT_BATCH = 10;
// v1.0.2：30s → 60s；大仓库首次建索引 + DashScope 冷启动场景下 30s 偏紧
const DEFAULT_TIMEOUT = 60_000;

export class DashScopeEmbedder implements Embedder {
  readonly dimension: number;
  readonly modelId: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: DashScopeEmbedderConfig) {
    if (!cfg.apiKey) {
      throw new AgentError({
        code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
        message: 'DashScope embedder 缺少 apiKey',
      });
    }
    this.apiKey = cfg.apiKey;
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.modelId = cfg.model ?? DEFAULT_MODEL;
    this.dimension = cfg.dimension ?? DEFAULT_DIM;
    this.batchSize = Math.max(1, cfg.batchSize ?? DEFAULT_BATCH);
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT;
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new AgentError({
        code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
        message: '运行环境缺少 fetch 实现',
      });
    }
  }

  async embed(inputs: string[], _opts?: EmbedOptions): Promise<EmbedResult> {
    // DashScope text-embedding-v3 不区分 passage/query，忽略 opts.kind。
    if (!inputs.length) return { vectors: [] };

    const vectors: number[][] = new Array(inputs.length);
    let totalTokens = 0;

    for (let i = 0; i < inputs.length; i += this.batchSize) {
      const batch = inputs.slice(i, i + this.batchSize);
      // 网络抖动 / 冷启动超时时自动重试 1 次
      // v1.0.2：TIMEOUT 也纳入 retry 白名单（之前只认 UNAVAILABLE，导致冷启动一次超时直接挂掉整个 reindex）
      let attempt = 0;
      let lastErr: unknown;
      let callResult: { data: Array<{ embedding: number[]; index: number }>; usage?: { total_tokens?: number } } | null = null;
      while (attempt < 2) {
        try {
          callResult = await this.callOnce(batch);
          break;
        } catch (e) {
          lastErr = e;
          const code = (e as AgentError).code;
          const retryable =
            code === ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE ||
            code === ErrorCodes.INDEX_EMBED_TIMEOUT;
          if (!retryable) throw e;
          attempt += 1;
          if (attempt >= 2) throw e;
          // 超时场景多给 DashScope 冷启动喘息（500ms → 1000ms）
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (!callResult) throw lastErr ?? new Error('embed call failed');
      const { data, usage } = callResult;
      // 按 index 回填（DashScope 可能乱序）
      for (const item of data) {
        if (!Array.isArray(item.embedding)) {
          throw new AgentError({
            code: ErrorCodes.INDEX_PARSE_FAIL,
            message: 'embedding 响应字段 embedding 非数组',
          });
        }
        vectors[i + item.index] = item.embedding;
      }
      if (usage?.total_tokens) totalTokens += usage.total_tokens;
    }

    // 兜底检查：任何一项缺失都视为失败
    for (let j = 0; j < vectors.length; j++) {
      if (!vectors[j]) {
        throw new AgentError({
          code: ErrorCodes.INDEX_PARSE_FAIL,
          message: `embedding 响应缺失 index=${j}`,
        });
      }
    }

    return { vectors, totalTokens };
  }

  private async callOnce(batch: string[]): Promise<{
    data: Array<{ embedding: number[]; index: number }>;
    usage?: { total_tokens?: number };
  }> {
    const url = `${this.baseUrl}/embeddings`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelId,
          input: batch,
          encoding_format: 'float',
        }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = e as Error & { cause?: { code?: string; errno?: string; syscall?: string; message?: string }; code?: string };
      const msg = err.message || String(e);
      if (/abort/i.test(msg)) {
        throw new AgentError({
          code: ErrorCodes.INDEX_EMBED_TIMEOUT,
          message: `embedding 请求超时（${this.timeoutMs}ms）`,
        });
      }
      // 把 undici / Node 的 cause 链打开，便于定位 ECONNRESET / ENOTFOUND / EPROTO 等
      const causeBits: string[] = [];
      if (err.code) causeBits.push(`code=${err.code}`);
      if (err.cause?.code) causeBits.push(`cause.code=${err.cause.code}`);
      if (err.cause?.errno) causeBits.push(`errno=${err.cause.errno}`);
      if (err.cause?.syscall) causeBits.push(`syscall=${err.cause.syscall}`);
      if (err.cause?.message && err.cause.message !== msg) causeBits.push(`cause=${err.cause.message}`);
      const detail = causeBits.length ? ` [${causeBits.join(' ')}]` : '';
      throw new AgentError({
        code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
        message: `embedding 网络错误: ${msg}${detail}`,
      });
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 429) {
      throw new AgentError({
        code: ErrorCodes.INDEX_EMBED_RATE_LIMITED,
        message: `embedding 接口限流（HTTP 429）`,
      });
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new AgentError({
        code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY,
        message: `embedding 接口鉴权失败（HTTP ${resp.status}）`,
      });
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new AgentError({
        code:
          resp.status >= 500 ? ErrorCodes.PROVIDER_SERVER_5XX : ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
        message: `embedding 接口错误 HTTP ${resp.status}: ${text.slice(0, 200)}`,
      });
    }

    let body: unknown;
    try {
      body = await resp.json();
    } catch (e) {
      throw new AgentError({
        code: ErrorCodes.INDEX_PARSE_FAIL,
        message: `embedding 响应非合法 JSON: ${(e as Error).message}`,
      });
    }

    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new AgentError({
        code: ErrorCodes.INDEX_PARSE_FAIL,
        message: 'embedding 响应缺少 data 数组',
      });
    }
    return {
      data: data as Array<{ embedding: number[]; index: number }>,
      usage: (body as { usage?: { total_tokens?: number } }).usage,
    };
  }
}

// ─────────── OllamaEmbedder（M4-Ollama） ───────────

/**
 * M4-Ollama · Ollama 本地 Embedder
 *
 * 调用 Ollama 的 /api/embeddings 接口做本地嵌入。
 * 默认模型：nomic-embed-text（768 维）
 * 响应格式（Ollama API）：
 *   POST /api/embeddings
 *   { model, prompt: string }
 *   → { embedding: number[] }
 *
 * 注意：Ollama API 单次只处理一条 prompt，多文本需串行/并行调用。
 * 这里用 Promise.all 做并行批次处理，batchSize 控制并发数。
 */
export interface OllamaEmbedderConfig {
  /** Ollama 服务地址；默认 http://127.0.0.1:11434 */
  baseUrl?: string;
  /** 模型名；默认 nomic-embed-text */
  model?: string;
  /** 向量维度；默认 768（nomic-embed-text 的维度） */
  dimension?: number;
  /** 并发批次大小；默认 4 */
  batchSize?: number;
  /** 单次请求超时；默认 30000ms */
  timeoutMs?: number;
  /** 自定义 fetch（便于单测注入） */
  fetchImpl?: typeof fetch;
}

const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';
const DEFAULT_OLLAMA_DIM = 768;
const DEFAULT_OLLAMA_BATCH = 4;
const DEFAULT_OLLAMA_TIMEOUT = 30_000;

export class OllamaEmbedder implements Embedder {
  readonly dimension: number;
  readonly modelId: string;

  private readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: OllamaEmbedderConfig = {}) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_OLLAMA_BASE).replace(/\/$/, '');
    this.modelId = cfg.model ?? DEFAULT_OLLAMA_MODEL;
    this.dimension = cfg.dimension ?? DEFAULT_OLLAMA_DIM;
    this.batchSize = cfg.batchSize ?? DEFAULT_OLLAMA_BATCH;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT;
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  }

  async embed(inputs: string[], _opts?: EmbedOptions): Promise<EmbedResult> {
    if (!inputs.length) return { vectors: [] };

    const vectors: number[][] = [];
    let totalTokens = 0;

    // 按 batchSize 分批并行调用
    for (let i = 0; i < inputs.length; i += this.batchSize) {
      const batch = inputs.slice(i, i + this.batchSize);
      const results = await Promise.all(
        batch.map((text) => this.callOnce(text)),
      );
      for (const r of results) {
        vectors.push(r.embedding);
        totalTokens += r.tokens;
      }
    }

    return { vectors, totalTokens };
  }

  private async callOnce(prompt: string): Promise<{ embedding: number[]; tokens: number }> {
    const url = `${this.baseUrl}/api/embeddings`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.modelId, prompt }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new AgentError({
          code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
          message: `Ollama embedding HTTP ${resp.status}: ${text.slice(0, 200)}`,
        });
      }

      const body = (await resp.json()) as {
        embedding?: number[];
        prompt_eval_count?: number;
      };
      if (!Array.isArray(body.embedding)) {
        throw new AgentError({
          code: ErrorCodes.INDEX_PARSE_FAIL,
          message: 'Ollama embedding 响应缺少 embedding 数组',
        });
      }
      return { embedding: body.embedding, tokens: body.prompt_eval_count ?? 0 };
    } catch (e) {
      clearTimeout(timer);
      const err = e as Error;
      if (/abort/i.test(err.message)) {
        throw new AgentError({
          code: ErrorCodes.INDEX_EMBED_TIMEOUT,
          message: `Ollama embedding 请求超时（${this.timeoutMs}ms）`,
        });
      }
      if (e instanceof AgentError) throw e;
      throw new AgentError({
        code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
        message: `Ollama embedding 失败: ${err.message}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 探测 Ollama 是否在线 */
  async probe(): Promise<boolean> {
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return false;
      const body = (await resp.json()) as { models?: Array<{ name: string }> };
      return Array.isArray(body.models);
    } catch {
      return false;
    }
  }
}
