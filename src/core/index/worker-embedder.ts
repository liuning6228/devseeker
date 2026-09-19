/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * WorkerEmbedder — 通过子进程 IPC 代理 embedding 推理
 *
 * 实现 Embedder 接口，内部 fork embedding-worker.js 子进程，
 * 将 ONNX 模型的 ~200-300MB 内存开销隔离在独立进程中。
 *
 * 使用方式与 LocalBertEmbedder 一致：
 *   const embedder = await WorkerEmbedder.create({ modelDir, extensionPath });
 *   const { vectors } = await embedder.embed(['hello'], { kind: 'query' });
 *   embedder.dispose(); // 释放子进程
 */

import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { Embedder, EmbedOptions, EmbedResult } from './embedder.js';
import { AgentError, ErrorCodes } from '../errors/index.js';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('index.worker-embedder');

export interface WorkerEmbedderConfig {
  /** 模型根目录绝对路径（同 LocalBertEmbedderConfig.modelDir） */
  modelDir: string;
  /** 扩展根目录（用于定位 out/embedding-worker.js） */
  extensionPath: string;
  /** 默认 'Xenova/multilingual-e5-small' */
  hfId?: string;
  /** 默认 384 */
  dimension?: number;
}

const DEFAULT_HF_ID = 'Xenova/multilingual-e5-small';
const DEFAULT_DIM = 384;
const INIT_TIMEOUT_MS = 30_000;  // 首次加载模型可能较慢
const EMBED_TIMEOUT_MS = 60_000;
/** 意外退出后的最大自动重启次数（防崩溃循环） */
const MAX_RESTARTS = 2;
/** 重启前等待（给 npm install / 系统恢复留出时间） */
const RESTART_DELAY_MS = 2_000;

let _idCounter = 0;
function nextId(): string {
  return `emb_${++_idCounter}_${Date.now()}`;
}

export class WorkerEmbedder implements Embedder {
  readonly dimension: number;
  readonly modelId: string;

  private worker: ChildProcess | null;
  private readonly config: Required<Pick<WorkerEmbedderConfig, 'modelDir' | 'extensionPath' | 'hfId' | 'dimension'>>;
  private pendingRequests = new Map<string, {
    resolve: (vectors: number[][]) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private disposed = false;
  /** 已消耗的自动重启次数（上限 MAX_RESTARTS） */
  private restartCount = 0;

  private constructor(
    config: Required<Pick<WorkerEmbedderConfig, 'modelDir' | 'extensionPath' | 'hfId' | 'dimension'>>,
    worker: ChildProcess,
    dimension: number,
    modelId: string,
  ) {
    this.config = config;
    this.worker = worker;
    this.dimension = dimension;
    this.modelId = modelId;
    this.setupWorkerListeners();
  }

  /**
   * 创建 WorkerEmbedder：fork 子进程 → 发送 init → 等待 ready。
   * 如果 init 超时或子进程崩溃，抛出 INDEX_EMBEDDER_UNAVAILABLE。
   */
  static async create(cfg: WorkerEmbedderConfig): Promise<WorkerEmbedder> {
    const hfId = cfg.hfId ?? DEFAULT_HF_ID;
    const dimension = cfg.dimension ?? DEFAULT_DIM;
    const extensionPath = cfg.extensionPath;
    const modelDir = cfg.modelDir;

    if (!modelDir || !extensionPath) {
      throw new AgentError({
        code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
        message: 'WorkerEmbedder 缺少 modelDir 或 extensionPath',
      });
    }

    const fullConfig = { modelDir, extensionPath, hfId, dimension };
    const { worker, dimension: readyDim, modelId } = await WorkerEmbedder.spawnWorker(fullConfig);
    return new WorkerEmbedder(fullConfig, worker, readyDim, modelId);
  }

  /**
   * fork 子进程并等待 ready（create 与崩溃重启共用）。
   * 返回 ready 后的 worker 与上报的 dimension/modelId。
   */
  private static spawnWorker(
    fullConfig: Required<Pick<WorkerEmbedderConfig, 'modelDir' | 'extensionPath' | 'hfId' | 'dimension'>>,
  ): Promise<{ worker: ChildProcess; dimension: number; modelId: string }> {
    const { modelDir, extensionPath, hfId, dimension } = fullConfig;
    const workerPath = path.join(extensionPath, 'out', 'embedding-worker.js');
    const worker = fork(workerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      // 清除继承的 execArgv（可能含 --inspect、Electron 内部参数等），防止子进程启动失败
      execArgv: [],
      // 确保子进程从扩展根目录解析 node_modules
      cwd: extensionPath,
      // 子进程独立内存空间，不受 Extension Host heap limit 约束
      env: { ...process.env },
    });

    // 收集 stderr 用于诊断
    let stderrChunks = '';
    if (worker.stderr) {
      worker.stderr.on('data', (chunk: Buffer) => {
        stderrChunks += chunk.toString().slice(0, 2000);
      });
    }

    // 等待 ready 或 error
    return new Promise<{ worker: ChildProcess; dimension: number; modelId: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.kill();
        reject(new AgentError({
          code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
          message: `embedding worker init 超时（${INIT_TIMEOUT_MS}ms）`,
        }));
      }, INIT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        worker.removeListener('message', onMessage);
        worker.removeListener('error', onError);
        worker.removeListener('exit', onExit);
      };

      const onMessage = (msg: { type: string; dimension?: number; modelId?: string; message?: string }) => {
        if (msg.type === 'ready') {
          cleanup();
          resolve({
            worker,
            dimension: msg.dimension ?? dimension,
            modelId: msg.modelId ?? hfId,
          });
        } else if (msg.type === 'error') {
          cleanup();
          reject(new AgentError({
            code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
            message: msg.message ?? 'embedding worker init 失败',
          }));
        }
      };

      const onError = (err: Error) => {
        cleanup();
        reject(new AgentError({
          code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
          message: `embedding worker 启动错误: ${err.message}`,
        }));
      };

      const onExit = (code: number | null, signal: string | null) => {
        cleanup();
        const detail = stderrChunks ? `\nstderr: ${stderrChunks.slice(0, 500)}` : '';
        reject(new AgentError({
          code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
          message: `embedding worker 退出 (code=${code}, signal=${signal})${detail}`,
        }));
      };

      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);

      // 发送 init
      worker.send({ type: 'init', modelDir, hfId, dimension });
    });
  }

  async embed(inputs: string[], opts?: EmbedOptions): Promise<EmbedResult> {
    if (!inputs.length) return { vectors: [] };
    if (this.disposed || !this.worker) {
      throw new AgentError({
        code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
        // 区分两种不可用：已销毁（终态） vs worker 退出/重启中（临时态）
        message: this.disposed
          ? 'WorkerEmbedder 已销毁'
          : 'WorkerEmbedder 暂不可用（worker 未就绪或重启中）',
      });
    }

    const id = nextId();
    const kind = opts?.kind ?? 'passage';

    return new Promise<EmbedResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new AgentError({
          code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
          message: `embedding 请求超时（${EMBED_TIMEOUT_MS}ms）`,
        }));
      }, EMBED_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: (vectors) => {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          resolve({ vectors });
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(err);
        },
        timer,
      });

      this.worker!.send({ type: 'embed', id, inputs, kind });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // 拒绝所有挂起的请求
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new AgentError({
        code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
        message: 'WorkerEmbedder 正在销毁',
      }));
    }
    this.pendingRequests.clear();

    // 优雅关闭
    if (this.worker) {
      try {
        this.worker.send({ type: 'shutdown' });
      } catch {
        // 子进程可能已退出
      }
      // 给 500ms 时间优雅退出，否则强杀
      const w = this.worker;
      setTimeout(() => {
        try { w.kill(); } catch { /* ignore */ }
      }, 500);
      this.worker = null;
    }
  }

  private setupWorkerListeners(): void {
    if (!this.worker) return;

    this.worker.on('message', (msg: { type: string; id?: string; vectors?: number[][]; message?: string; code?: string }) => {
      if (msg.type === 'result' && msg.id) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          pending.resolve(msg.vectors ?? []);
        }
      } else if (msg.type === 'error' && msg.id) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          pending.reject(new AgentError({
            code: (msg.code as string) === 'INDEX_PARSE_FAIL'
              ? ErrorCodes.INDEX_PARSE_FAIL
              : ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
            message: msg.message ?? 'embedding worker 错误',
          }));
        }
      }
    });

    this.worker.on('exit', (code) => {
      // 已销毁（正常关闭）或旧 worker 已被替换（重启后残留实例）→ 忽略
      if (this.disposed || this.worker === null) return;
      // 子进程意外退出，拒绝所有挂起请求
      const err = new AgentError({
        code: ErrorCodes.INDEX_EMBEDDER_UNAVAILABLE,
        message: `embedding worker 意外退出 (code=${code})`,
      });
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pendingRequests.clear();
      this.worker = null;
      // 自动重启（此前无日志无重启：退出后所有 embed 持续以"已销毁"失败，
      // watcher 逐文件刷 warn，线上曾持续 17 分钟 7944 条）
      void this.tryRestart(code);
    });
  }

  /**
   * worker 意外退出后的自动重启（上限 MAX_RESTARTS 次，防崩溃循环）。
   * 重启失败也按上限继续重试；达上限后停用并明确告知。
   */
  private async tryRestart(exitCode: number | null): Promise<void> {
    if (this.disposed) return;
    if (this.restartCount >= MAX_RESTARTS) {
      log.warn(
        { exitCode, restarts: this.restartCount },
        'embedding worker 连续退出且重启达上限；本会话内索引增量更新暂停（已建索引检索不受影响）',
      );
      return;
    }
    this.restartCount++;
    log.warn({ exitCode, restart: this.restartCount }, 'embedding worker 意外退出，尝试自动重启');
    await new Promise((r) => setTimeout(r, RESTART_DELAY_MS));
    if (this.disposed) return;
    try {
      const { worker } = await WorkerEmbedder.spawnWorker(this.config);
      if (this.disposed) {
        try { worker.kill(); } catch { /* ignore */ }
        return;
      }
      this.worker = worker;
      this.setupWorkerListeners();
      log.info({ restart: this.restartCount }, 'embedding worker 重启成功');
    } catch (e) {
      log.warn({ err: (e as Error).message, restart: this.restartCount }, 'embedding worker 重启失败');
      // 按上限继续重试（restartCount 已自增，不会无限循环）
      void this.tryRestart(null);
    }
  }
}
