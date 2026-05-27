/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CheckpointCoordinator —— Panel 与 CheckpointStore 之间的协调层
 *
 * 职责（W5b2b）：
 * - 在每轮 TaskLoop 执行期间拦截写类工具（write_file / search_replace），
 *   在工具执行**前**读出目标文件的当前内容，缓存到 pending 表。
 * - 任务结束时（post_task）汇总 pending 文件 + 最新 messages，调用 CheckpointStore.create
 *   一次性落盘，作为"任务前的快照"。
 * - 向 Panel / Command 层暴露 list / revert 的薄包装。
 *
 * 设计要点：
 * - 同一轮内同一 relPath 只记录**首次**读到的内容（保持 checkpoint 为"任务开始时的状态"）。
 * - 支持的工具白名单（MVP）：write_file / search_replace；
 *   其他工具（bash / edit via LSP / ...）暂不追踪，避免误快照。
 * - 读文件失败当作"当时不存在"（content=null，wasDeleted=true），而非阻塞任务。
 *
 * 线程/并发：
 * - trackFileWrite 是 fire-and-forget；beginTurn 前必须已 finalize 上一轮。
 * - Panel 保证串行调用（taskLoop 单例）。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../../infra/logger.js';
import type { CheckpointStore } from './store.js';
import type { Checkpoint, CheckpointMeta, RevertResult } from './types.js';
import type { Message } from '../../providers/types.js';

const log = getLogger('checkpoint.coordinator');

/** 会触发文件快照的工具名白名单 */
export const TRACKED_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'append_file',
  'search_replace',
  'delete_file',
]);

export interface CheckpointCoordinatorOptions {
  store: CheckpointStore;
  workspaceRoot: string;
  /** 是否启用自动快照，默认 true；禁用则 finalizeTurn 返回 undefined */
  enabled?: boolean;
}

export interface FinalizeArgs {
  sessionId: string;
  messages: Message[];
  label?: string;
  /** 即使 pending 为空、messages 也不为空，是否依然创建快照（默认 true） */
  forceEmpty?: boolean;
}

export class CheckpointCoordinator {
  private readonly store: CheckpointStore;
  private readonly workspaceRoot: string;
  private enabled: boolean;

  /** relPath → 任务前的内容（null = 任务开始时文件不存在） */
  private pending = new Map<string, string | null>();
  /** 正在进行的读操作，保证 finalize 时能等齐 */
  private readonly inflight: Promise<void>[] = [];
  /** 本 turn 内已创建的 step checkpoint 计数（用于 label 编号） */
  private stepCounter = 0;

  constructor(opts: CheckpointCoordinatorOptions) {
    this.store = opts.store;
    this.workspaceRoot = opts.workspaceRoot;
    this.enabled = opts.enabled ?? true;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 每次新的用户 send 前调用。清空上一轮残留。 */
  beginTurn(): void {
    this.pending.clear();
    this.inflight.length = 0;
    this.stepCounter = 0;
  }

  /**
   * 工具执行事件：若是跟踪的写类工具，读取并缓存 file_path 对应文件的原始内容。
   * - 非白名单工具直接忽略
   * - 同一 relPath 已记录 → 忽略（保留首次值）
   */
  onToolExec(toolName: string, args: unknown): void {
    if (!this.enabled) return;
    if (!TRACKED_WRITE_TOOLS.has(toolName)) return;
    const relPath = extractFilePath(args);
    if (!relPath) return;
    const normalized = normalizeRelPath(relPath);
    if (!normalized) return;
    if (this.pending.has(normalized)) return;
    // 标记占位，避免并发重复读
    this.pending.set(normalized, null);
    const p = this.readCurrent(normalized).then((content) => {
      // 若 readCurrent 成功，覆盖占位；失败保持 null
      this.pending.set(normalized, content);
    });
    this.inflight.push(p);
  }

  /**
   * W7b2 · DESIGN §M15.3 step 粒度 checkpoint
   *
   * 每次 TRACKED 写类工具执行**前**立即创建一个 checkpoint，
   * 记录"此时此刻" file_path 文件的原始内容（或不存在），以及当前消息历史。
   * 不依赖 pending / turn 结束，单独成轨。
   *
   * 返回 undefined 的情况：
   * - 被禁用 / sessionId 为空
   * - 非 TRACKED 工具或无 file_path
   * - 无法解析 relPath（绝对路径 / 穿越）
   *
   * label 规范：`step:<N>:<toolName>` —— N 为本 turn 内的 step 序号（beginTurn 重置）。
   * 失败不抛（吞掉异常返回 undefined），避免阻塞工具执行。
   */
  async createStepCheckpoint(args: {
    sessionId: string;
    messages: Message[];
    toolName: string;
    toolArgs: unknown;
  }): Promise<Checkpoint | undefined> {
    if (!this.enabled) return undefined;
    if (!args.sessionId) return undefined;
    if (!TRACKED_WRITE_TOOLS.has(args.toolName)) return undefined;
    const relPath = extractFilePath(args.toolArgs);
    if (!relPath) return undefined;
    const normalized = normalizeRelPath(relPath);
    if (!normalized) return undefined;

    const content = await this.readCurrent(normalized);
    this.stepCounter += 1;
    const label = `step:${this.stepCounter}:${args.toolName}`;

    try {
      const cp = await this.store.create({
        sessionId: args.sessionId,
        messages: args.messages,
        files: [{ relPath: normalized, content }],
        label,
      });
      log.info(
        { id: cp.id, sessionId: args.sessionId, step: this.stepCounter, tool: args.toolName, relPath: normalized },
        'step checkpoint created',
      );
      return cp;
    } catch (e) {
      log.warn(
        { err: String(e), sessionId: args.sessionId, tool: args.toolName },
        'step checkpoint create failed',
      );
      return undefined;
    }
  }

  /**
   * 任务结束时调用。等待所有读取完成 → 调 store.create。
   * 返回 undefined 的情况：disabled / sessionId 为空。
   */
  async finalizeTurn(args: FinalizeArgs): Promise<Checkpoint | undefined> {
    if (!this.enabled) return undefined;
    if (!args.sessionId) return undefined;

    // 等齐所有 inflight 读取
    if (this.inflight.length > 0) {
      await Promise.allSettled(this.inflight);
      this.inflight.length = 0;
    }

    const files = Array.from(this.pending.entries()).map(([relPath, content]) => ({
      relPath,
      content,
    }));
    this.pending.clear();

    // 空 messages 不写（避免创建无内容 checkpoint）
    if (args.messages.length === 0 && files.length === 0) return undefined;
    if (files.length === 0 && args.forceEmpty === false) return undefined;

    try {
      const cp = await this.store.create({
        sessionId: args.sessionId,
        messages: args.messages,
        files,
        ...(args.label !== undefined ? { label: args.label } : {}),
      });
      log.info(
        { id: cp.id, sessionId: args.sessionId, files: files.length, label: args.label },
        'checkpoint created',
      );
      return cp;
    } catch (e) {
      log.warn({ err: String(e), sessionId: args.sessionId }, 'checkpoint create failed');
      return undefined;
    }
  }

  /** 列出某 session 的 checkpoint 元信息（按 createdAt 升序） */
  async list(sessionId: string): Promise<CheckpointMeta[]> {
    return this.store.list(sessionId);
  }

  /** 恢复某 checkpoint */
  async revert(args: {
    id: string;
    sessionId: string;
    applyFiles?: boolean;
  }): Promise<RevertResult> {
    return this.store.revert(args);
  }

  /** 读一个 checkpoint 的完整 payload */
  async get(id: string, sessionId: string): Promise<Checkpoint | undefined> {
    return this.store.get(id, sessionId);
  }

  /** 定向删除某个 checkpoint，返回 true 表示确实移除了一条 */
  async delete(id: string, sessionId: string): Promise<boolean> {
    return this.store.delete(id, sessionId);
  }

  // ─────────── internals ───────────

  /**
   * 读当前文件内容；若不存在或读失败，返回 null（作为 wasDeleted 快照）。
   * 二进制/非 UTF-8 文件暂视为不存在。
   */
  private async readCurrent(relPath: string): Promise<string | null> {
    const abs = path.resolve(this.workspaceRoot, relPath);
    try {
      const content = await fs.readFile(abs, 'utf-8');
      return content;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code && code !== 'ENOENT') {
        log.debug({ err: String(e), relPath }, 'readCurrent non-ENOENT failure; treat as missing');
      }
      return null;
    }
  }
}

// ─────────── helpers ───────────

function extractFilePath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const rec = args as Record<string, unknown>;
  const v = rec.file_path ?? rec.filePath;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * 归一化相对路径：统一 / 分隔；拒绝绝对路径 / 穿越。
 * 绝对路径若落在 workspace 内，会被去前缀（保留相对部分）——
 *   为保守起见，MVP 不做这种转换，直接返回 undefined 由调用方跳过。
 */
function normalizeRelPath(p: string): string | undefined {
  if (!p) return undefined;
  const s = p.replace(/\\/g, '/');
  if (s.startsWith('/')) return undefined;
  if (/^[A-Za-z]:\//.test(s)) return undefined; // Windows 绝对路径
  const parts = s.split('/').filter((x) => x !== '');
  if (parts.some((x) => x === '..' || x === '.')) return undefined;
  return parts.join('/');
}
