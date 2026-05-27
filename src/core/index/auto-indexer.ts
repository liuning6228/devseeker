/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-1.0.1-A · 打开工作区自动后台索引
 *
 * 目标：用户打开 VS Code 进入一个项目工作区时，DevSeeker 扩展激活后在后台
 * 悄悄建立代码库索引，避免「代码库未索引」黄条常驻。
 *
 * 设计要点：
 *  - 只在工作区存在「项目标识文件」（package.json / tsconfig.json / go.mod
 *    / pyproject.toml / Cargo.toml / pom.xml 等）时触发；纯文档仓库或空目
 *    录不触发。
 *  - 激活后延迟 3s 执行，避开冷启动与其他 activate 任务争抢 CPU。
 *  - 24h 内只触发一次（workspaceState 持久化时间戳）；后续打开直接加载已
 *    持久化的 `.devseeker/codebase-index.json`。
 *  - 如果 `CodebaseIndex.create` loadFromFile 到非空数据（`size() > 0`），说
 *    明已有现成索引，直接更新 marker、跳过 reindex。
 *  - API Key 缺失 / embedder 构造失败 / reindex 失败：只打 log，不弹 UI，
 *    不影响用户其他操作。
 *  - 所有副作用可注入（buildEmbedder / createIndex / now / fs 存在性检查），
 *    便于单测。
 */

import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  CodebaseIndex,
  defaultIndexStorePath,
  type CodebaseIndexOptions,
  type CodebaseIndexLike,
} from './codebase-index.js';
import {
  Bm25CodebaseIndex,
  defaultBm25IndexStorePath,
  type Bm25CodebaseIndexOptions,
} from './bm25-codebase-index.js';
import { DashScopeEmbedder, type Embedder } from './embedder.js';
import { WorkerEmbedder } from './worker-embedder.js';
import type { Logger } from 'pino';

/** 任一命中即视为「值得索引」的项目。纯 README 仓库不触发。 */
export const PROJECT_MARKER_FILES: readonly string[] = [
  'package.json',
  'tsconfig.json',
  'go.mod',
  'pyproject.toml',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'mix.exs',
  'CMakeLists.txt',
  'Makefile',
  'requirements.txt',
];

/** 激活后延迟多久再触发后台索引（ms）。避让冷启动。 */
export const AUTO_INDEX_DELAY_MS = 3_000;

/** workspaceState 中保存「上次自动索引时间戳」的 key。 */
export const AUTO_INDEX_MARKER_KEY = 'devSeeker.autoIndex.lastRun';

/** 同一工作区多久之内不重跑自动索引（ms）。 */
export const AUTO_INDEX_RERUN_MS = 24 * 60 * 60 * 1000;

/** 自动索引跳过/执行结果（用于单测与日志）。 */
export type AutoIndexOutcome =
  | 'no-workspace'
  | 'no-project-marker'
  | 'recently-ran'
  | 'no-api-key'
  | 'embedder-failed'
  | 'already-populated'
  | 'reindexed'
  | 'reindex-failed';

/** B-1.0.1-D · 状态回调的状态枚举（与 index-status-bar.ts IndexState 对齐） */
export type AutoIndexState =
  | 'no-workspace'
  | 'indexing'
  | 'ready'
  | 'empty'
  | 'error';

/** 状态回调载荷。 */
export interface AutoIndexStateInfo {
  fileCount?: number;
  message?: string;
}

/** 可注入的依赖集合。默认值通过 `createDefault*` 工厂生成，便于单测替换。 */
export interface AutoIndexerDeps {
  context: vscode.ExtensionContext;
  log: Logger;
  /** 工作区根路径；默认读 `vscode.workspace.workspaceFolders[0]`。 */
  workspaceRoot?: string;
  /** 文件存在性检查；默认走 fs.access。 */
  exists?: (path: string) => Promise<boolean>;
  /**
   * 构造 embedder；返回 undefined 表示 API Key 缺失或构造失败（软跳过）。
   * v1.2.0：可以返回 Promise 以支持 local-bert 异步加载；单测的同步实现依然兼容。 */
  buildEmbedder?: (
    config: vscode.WorkspaceConfiguration,
  ) => Embedder | undefined | Promise<Embedder | undefined>;
  /** 构造 CodebaseIndex；默认用 CodebaseIndex.create。 */
  createIndex?: (opts: CodebaseIndexOptions) => Promise<CodebaseIndex>;
  /**
   * W13.4-C-2 · 构造 Bm25CodebaseIndex；默认用 Bm25CodebaseIndex.create。
   * provider='bm25' 时走此路径，完全绕过 embedder 构造。
   */
  createBm25Index?: (opts: Bm25CodebaseIndexOptions) => Promise<Bm25CodebaseIndex>;
  /** 时间注入（单测用）。 */
  now?: () => number;
  /** 调度注入：不给则默认使用 setTimeout。传 null 表示同步立即执行（单测用）。 */
  schedule?: ((fn: () => void | Promise<void>, delayMs: number) => void) | null;
  /** B-1.0.1-D · 状态变更回调，用于更新状态栏；不传则不推。 */
  onStateChange?: (state: AutoIndexState, info?: AutoIndexStateInfo) => void;
}

/**
 * 在 extension.activate() 末尾调用。
 *
 * 本函数**不抛异常**；所有错误只打 log，不影响扩展激活。
 * 同步返回一个 Promise，但 Promise 本身不会 reject。
 */
export async function maybeAutoReindex(deps: AutoIndexerDeps): Promise<AutoIndexOutcome> {
  const { context, log, onStateChange } = deps;
  const now = deps.now ?? (() => Date.now());
  const notify = (state: AutoIndexState, info?: AutoIndexStateInfo): void => {
    try { onStateChange?.(state, info); } catch { /* never throw */ }
  };

  // 1) 工作区守卫
  const workspaceRoot =
    deps.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    log.debug('autoIndex: no workspace folder, skip');
    notify('no-workspace');
    return 'no-workspace';
  }

  // 2) 项目标识守卫
  const hasMarker = await anyMarkerExists(workspaceRoot, deps.exists);
  if (!hasMarker) {
    log.debug({ workspaceRoot }, 'autoIndex: no project marker, skip');
    return 'no-project-marker';
  }

  // 3) 24h 防重跑
  const lastRun = context.workspaceState.get<number>(AUTO_INDEX_MARKER_KEY);
  if (typeof lastRun === 'number' && now() - lastRun < AUTO_INDEX_RERUN_MS) {
    log.debug({ workspaceRoot, lastRun }, 'autoIndex: recently ran, skip');
    return 'recently-ran';
  }

  // 4) 构造 embedder（API Key 缺失 / local-bert 模型加载失败 → 软跳过，不打扰）
  const useDefaultEmbedder = deps.buildEmbedder === undefined;
  const buildEmbedder =
    deps.buildEmbedder ?? ((cfg) => defaultBuildEmbedder(cfg, context.extensionPath));
  const config = vscode.workspace.getConfiguration('devSeeker');
  const provider = (
    config.get<string>('codebaseIndex.embedProvider', 'local-bert') || 'local-bert'
  ).trim();

  // W13.4-C-2 · BM25 路径：完全绕过 embedder，直接分派到 Bm25CodebaseIndex。
  // 冷启动 <1s，零模型依赖；适合低配置机器 / CI / 隐私场景。
  if (provider === 'bm25') {
    notify('indexing', { message: '使用 BM25 lexical 索引（零模型保底）' });
    const runBm25 = (): Promise<AutoIndexOutcome> =>
      runBm25AutoReindex({
        ...deps,
        workspaceRoot,
        now,
        notify,
      });
    const sch = deps.schedule === undefined ? defaultSchedule : deps.schedule;
    if (sch === null) return await runBm25();
    sch(() => {
      void runBm25().catch((e) => {
        log.warn({ err: (e as Error).message }, 'autoIndex(bm25): unexpected error');
        notify('error', { message: (e as Error).message });
      });
    }, AUTO_INDEX_DELAY_MS);
    return 'reindexed';
  }

  // v1.2.0 W13.6 · 默认路径 + local-bert 时，首次加载 ONNX 模型 5–10s。
  // 提前推一条黄条，避免用户觉得卡死。测试注入自定义 buildEmbedder 时不推，保持旧 state change 计数不变。
  if (useDefaultEmbedder) {
    if (provider === 'local-bert') {
      notify('indexing', { message: '正在加载离线 embedding 模型…（首次 5–10s）' });
    }
  }
  let embedder: Embedder | undefined;
  try {
    embedder = await buildEmbedder(config);
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'autoIndex: buildEmbedder threw');
    return 'embedder-failed';
  }
  if (!embedder) {
    log.debug('autoIndex: embedder unavailable (likely no API key), skip');
    return 'no-api-key';
  }

  // 5) 调度：默认延迟 3s，避开冷启动高峰
  const schedule = deps.schedule === undefined ? defaultSchedule : deps.schedule;
  const run = (): Promise<AutoIndexOutcome> =>
    runAutoReindex({
      ...deps,
      workspaceRoot,
      embedder: embedder as Embedder,
      now,
      notify,
    });

  if (schedule === null) {
    // 单测路径：立即执行
    return await run();
  }

  // 生产路径：后台异步，不 await
  schedule(() => {
    void run().catch((e) => {
      log.warn({ err: (e as Error).message }, 'autoIndex: unexpected error');
      notify('error', { message: (e as Error).message });
    });
  }, AUTO_INDEX_DELAY_MS);
  return 'reindexed'; // 已调度，视作「将要重建」；真实结果由 run() 里打 log
}

/** 检查工作区根目录下是否存在任一项目标识文件。 */
export async function anyMarkerExists(
  workspaceRoot: string,
  exists?: (path: string) => Promise<boolean>,
): Promise<boolean> {
  const check = exists ?? defaultExists;
  for (const marker of PROJECT_MARKER_FILES) {
    if (await check(join(workspaceRoot, marker))) return true;
  }
  return false;
}

/** 真正执行 reindex 的内部函数。被 maybeAutoReindex 调度。 */
async function runAutoReindex(params: {
  context: vscode.ExtensionContext;
  log: Logger;
  workspaceRoot: string;
  embedder: Embedder;
  createIndex?: (opts: CodebaseIndexOptions) => Promise<CodebaseIndex>;
  now: () => number;
  notify: (state: AutoIndexState, info?: AutoIndexStateInfo) => void;
}): Promise<AutoIndexOutcome> {
  const { context, log, workspaceRoot, embedder, now, notify } = params;
  const createIndex = params.createIndex ?? ((opts) => CodebaseIndex.create(opts));

  try {
    const storePath = defaultIndexStorePath(workspaceRoot);
    const idx = await createIndex({ workspaceRoot, embedder, storePath });

    // 若已有持久化数据（load 成功且 size > 0），说明无需再 reindex。
    // 只更新 marker 防止下次重跑。
    if (idx.size() > 0) {
      await context.workspaceState.update(AUTO_INDEX_MARKER_KEY, now());
      log.info(
        { workspaceRoot, size: idx.size() },
        'autoIndex: existing index loaded, skip reindex',
      );
      // 容错：某些 mock/旧版本无 listIndexedFiles 时降级用 size()
      let fc = 0;
      try {
        fc = idx.listIndexedFiles().length;
      } catch {
        fc = idx.size();
      }
      notify('ready', { fileCount: fc });
      return 'already-populated';
    }

    log.info({ workspaceRoot }, 'autoIndex: reindex start');
    notify('indexing', { message: '后台扫描并向量化中…' });
    const stats = await idx.reindex();
    await context.workspaceState.update(AUTO_INDEX_MARKER_KEY, now());

    // B-1.0.1-C · 0 files 时打诊断日志，列前 10 条被过滤样本与原因
    if (stats.filesScanned === 0) {
      log.warn(
        {
          workspaceRoot,
          filesSkippedExt: stats.filesSkippedExt,
          filesSkippedLarge: stats.filesSkippedLarge,
          filterSamples: stats.filterSamples,
        },
        'autoIndex: scanned 0 files, showing up to 10 filtered samples for diagnosis',
      );
      notify('empty', {
        fileCount: 0,
        message: '未扫到任何源码文件，点击重试或查看诊断日志。',
      });
    } else {
      notify('ready', { fileCount: stats.filesScanned });
    }

    log.info(
      {
        workspaceRoot,
        filesScanned: stats.filesScanned,
        chunksEmbedded: stats.chunksEmbedded,
        durationMs: stats.durationMs,
      },
      'autoIndex: reindex done',
    );
    return 'reindexed';
  } catch (e) {
    // 失败不弹 UI：黄条仍会在用户下次打开面板时提示需要手动 Reindex
    log.warn(
      { workspaceRoot, err: (e as Error).message },
      'autoIndex: reindex failed, silently backoff',
    );
    notify('error', { message: (e as Error).message });
    return 'reindex-failed';
  }
}

/**
 * W13.4-C-2 · BM25 路径的 reindex runner。
 *
 * 与 `runAutoReindex` 对称但绕过 embedder：
 *   - 直接创建 `Bm25CodebaseIndex`（通过 `createBm25Index` DI，可注入）
 *   - 落盘到 `<workspaceRoot>/.devseeker/bm25-index.json`（与向量库分家）
 *   - 其它分支（已有数据跳过 / 0 文件诊断 / 失败软降级）逻辑与向量路径一致
 */
async function runBm25AutoReindex(params: {
  context: vscode.ExtensionContext;
  log: Logger;
  workspaceRoot: string;
  createBm25Index?: (opts: Bm25CodebaseIndexOptions) => Promise<Bm25CodebaseIndex>;
  now: () => number;
  notify: (state: AutoIndexState, info?: AutoIndexStateInfo) => void;
}): Promise<AutoIndexOutcome> {
  const { context, log, workspaceRoot, now, notify } = params;
  const createBm25Index =
    params.createBm25Index ?? ((opts) => Bm25CodebaseIndex.create(opts));

  try {
    const storePath = defaultBm25IndexStorePath(workspaceRoot);
    const idx = await createBm25Index({ workspaceRoot, storePath });

    if (idx.size() > 0) {
      await context.workspaceState.update(AUTO_INDEX_MARKER_KEY, now());
      log.info(
        { workspaceRoot, size: idx.size() },
        'autoIndex(bm25): existing index loaded, skip reindex',
      );
      let fc = 0;
      try {
        fc = idx.listIndexedFiles().length;
      } catch {
        fc = idx.size();
      }
      notify('ready', { fileCount: fc });
      return 'already-populated';
    }

    log.info({ workspaceRoot }, 'autoIndex(bm25): reindex start');
    notify('indexing', { message: '后台扫描 + BM25 入库中…' });
    const stats = await idx.reindex();
    await context.workspaceState.update(AUTO_INDEX_MARKER_KEY, now());

    if (stats.filesScanned === 0) {
      log.warn(
        {
          workspaceRoot,
          filesSkippedExt: stats.filesSkippedExt,
          filesSkippedLarge: stats.filesSkippedLarge,
          filterSamples: stats.filterSamples,
        },
        'autoIndex(bm25): scanned 0 files, showing up to 10 filtered samples for diagnosis',
      );
      notify('empty', {
        fileCount: 0,
        message: '未扫到任何源码文件，点击重试或查看诊断日志。',
      });
    } else {
      notify('ready', { fileCount: stats.filesScanned });
    }

    log.info(
      {
        workspaceRoot,
        filesScanned: stats.filesScanned,
        chunksEmbedded: stats.chunksEmbedded,
        durationMs: stats.durationMs,
      },
      'autoIndex(bm25): reindex done',
    );
    return 'reindexed';
  } catch (e) {
    log.warn(
      { workspaceRoot, err: (e as Error).message },
      'autoIndex(bm25): reindex failed, silently backoff',
    );
    notify('error', { message: (e as Error).message });
    return 'reindex-failed';
  }
}

/** 默认调度器：setTimeout。 */
function defaultSchedule(fn: () => void | Promise<void>, delayMs: number): void {
  setTimeout(() => {
    void fn();
  }, delayMs);
}

/** 默认存在性检查：fs.access。 */
async function defaultExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 默认 embedder 构造：根据 `codebaseIndex.embedProvider` 分派。
 * v1.2.0：
 *   - local-bert（默认）：加载打进 VSIX 的 multilingual-e5-small 离线模型
 *   - dashscope：复用原有 DashScope 路径，API Key 缺失软跳过
 * 任何异常都返回 undefined（静默跳过），**不抛错**。
 */
async function defaultBuildEmbedder(
  config: vscode.WorkspaceConfiguration,
  extensionPath: string,
): Promise<Embedder | undefined> {
  const provider = (
    config.get<string>('codebaseIndex.embedProvider', 'local-bert') || 'local-bert'
  ).trim();

  if (provider === 'local-bert') {
    try {
      // modelDir 传的是「父目录」，hfId 由 transformers.js 拼接。
      // 真实模型路径：<ext>/models/Xenova/multilingual-e5-small/
      const modelDir = join(extensionPath, 'models');
      return await WorkerEmbedder.create({ modelDir, extensionPath });
    } catch {
      return undefined;
    }
  }

  // dashscope
  const apiKey = config.get<string>('qwenVl.apiKey', '').trim();
  if (!apiKey) return undefined;

  const baseUrl = config.get<string>('qwenVl.baseUrl', '').trim();
  const model = config.get<string>('codebaseIndex.embedModel', 'text-embedding-v3').trim();
  const dimension = config.get<number>('codebaseIndex.embedDimension', 1024);
  const batchSize = config.get<number>('codebaseIndex.embedBatchSize', 10);

  try {
    return new DashScopeEmbedder({
      apiKey,
      baseUrl: baseUrl || undefined,
      model,
      dimension,
      batchSize,
    });
  } catch {
    return undefined;
  }
}
