/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Embedding Worker — 独立子进程运行 ONNX 模型推理
 *
 * 通过 child_process.fork() 启动，与主进程通过 IPC (process.send/on) 通信。
 * 将 @huggingface/transformers + onnxruntime-node + 113MB ONNX 模型
 * 的内存开销（~200-300MB）隔离在独立进程中，避免 Extension Host GC 卡顿。
 *
 * IPC 协议：
 *   Main → Worker:
 *     { type: 'init', modelDir, hfId, dimension }
 *     { type: 'embed', id, inputs, kind }
 *     { type: 'shutdown' }
 *   Worker → Main:
 *     { type: 'ready', dimension, modelId }
 *     { type: 'result', id, vectors }
 *     { type: 'error', id?, message, code? }
 */

import * as os from 'node:os';

// ─── IPC 消息类型 ───

interface InitMsg {
  type: 'init';
  modelDir: string;
  hfId: string;
  dimension: number;
}

interface EmbedMsg {
  type: 'embed';
  id: string;
  inputs: string[];
  kind: 'passage' | 'query';
}

interface ShutdownMsg {
  type: 'shutdown';
}

type IncomingMsg = InitMsg | EmbedMsg | ShutdownMsg;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FeatureExtractionPipeline = (inputs: string[], opts?: Record<string, unknown>) => Promise<any>;

let extractor: FeatureExtractionPipeline | null = null;
let modelId = '';
let dimension = 384;

function send(msg: Record<string, unknown>): void {
  if (process.send) {
    process.send(msg);
  }
}

async function handleInit(msg: InitMsg): Promise<void> {
  try {
    const hfId = msg.hfId || 'Xenova/multilingual-e5-small';
    dimension = msg.dimension || 384;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@huggingface/transformers') as {
      pipeline: (...args: unknown[]) => Promise<unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env: any;
    };

    // 配置本地模型路径
    mod.env.localModelPath = msg.modelDir;
    mod.env.allowLocalModels = true;
    mod.env.allowRemoteModels = false;

    // 配置 WASM 后端参数
    if (mod.env.backends?.onnx?.wasm) {
      const cores = Math.max(1, os.cpus().length || 2);
      mod.env.backends.onnx.wasm.numThreads = Math.min(4, cores);
      mod.env.backends.onnx.wasm.simd = true;
    }

    // 加载模型
    extractor = (await mod.pipeline('feature-extraction', hfId, {
      dtype: 'q8',
    })) as unknown as FeatureExtractionPipeline;

    modelId = hfId;
    send({ type: 'ready', dimension, modelId });
  } catch (e) {
    send({
      type: 'error',
      message: `模型加载失败: ${(e as Error).message}`,
      code: 'INDEX_EMBEDDER_UNAVAILABLE',
    });
    // 加载失败后退出，让主进程决定是否重试
    process.exit(1);
  }
}

async function handleEmbed(msg: EmbedMsg): Promise<void> {
  if (!extractor) {
    send({
      type: 'error',
      id: msg.id,
      message: '模型未初始化',
      code: 'INDEX_EMBEDDER_UNAVAILABLE',
    });
    return;
  }

  try {
    const prefix = msg.kind === 'query' ? 'query: ' : 'passage: ';
    const prefixed = msg.inputs.map((s) => prefix + s);

    const out = await extractor(prefixed, {
      pooling: 'mean',
      normalize: true,
    });

    let vectors: number[][];
    if (out && typeof out.tolist === 'function') {
      vectors = out.tolist();
    } else if (Array.isArray(out)) {
      vectors = out as number[][];
    } else {
      send({
        type: 'error',
        id: msg.id,
        message: '推理返回非预期结构',
        code: 'INDEX_PARSE_FAIL',
      });
      return;
    }

    // 维度校验
    if (vectors.length !== msg.inputs.length) {
      send({
        type: 'error',
        id: msg.id,
        message: `输出条数不一致: got ${vectors.length} expect ${msg.inputs.length}`,
        code: 'INDEX_PARSE_FAIL',
      });
      return;
    }

    send({ type: 'result', id: msg.id, vectors });
  } catch (e) {
    send({
      type: 'error',
      id: msg.id,
      message: `推理失败: ${(e as Error).message}`,
      code: 'INDEX_PARSE_FAIL',
    });
  }
}

// ─── 主循环 ───

process.on('message', (msg: IncomingMsg) => {
  switch (msg.type) {
    case 'init':
      void handleInit(msg);
      break;
    case 'embed':
      void handleEmbed(msg);
      break;
    case 'shutdown':
      process.exit(0);
      break;
  }
});

// 防止未捕获异常导致静默退出
process.on('uncaughtException', (err) => {
  send({
    type: 'error',
    message: `worker uncaughtException: ${err.message}`,
    code: 'INDEX_EMBEDDER_UNAVAILABLE',
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  send({
    type: 'error',
    message: `worker unhandledRejection: ${String(reason)}`,
    code: 'INDEX_EMBEDDER_UNAVAILABLE',
  });
  process.exit(1);
});
