/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CancellationToken — DESIGN §M15.4 取消协议
 *
 * 在 AbortController / AbortSignal 之上提供 VS Code-风格的取消 API：
 * - `isCancelled: boolean` —— 状态幂等查询
 * - `onCancel(cb): Disposable` —— 注册回调（cancel 之后注册仍会立即触发一次）
 * - `throwIfCancelled()` —— 抛 CancellationError
 * - `cancel()` —— 幂等触发
 *
 * 与 AbortSignal 双向互通：
 * - `CancellationToken.from(signal)` 将外部 AbortSignal 包装为 token
 * - `token.toAbortSignal()` 导出 signal，供 fetch / subagent runner 使用
 *
 * 设计取舍（MVP）：
 * - 不引入 VS Code 专属类型，纯 Node/browser 兼容，供 TaskLoop / tools / 子代理统一消费
 * - onCancel 返回的 Disposable 仅能销毁回调注册，无法反向复活 token
 */

import { CancellationError } from './error.js';

export interface Disposable {
  dispose(): void;
}

export interface ICancellationToken {
  readonly isCancelled: boolean;
  onCancel(cb: () => void): Disposable;
  throwIfCancelled(): void;
}

export class CancellationToken implements ICancellationToken {
  /** 永远不会取消的 token（长生命周期背景任务占位用） */
  static readonly None: ICancellationToken = Object.freeze({
    get isCancelled(): boolean {
      return false;
    },
    onCancel(_cb: () => void): Disposable {
      return { dispose(): void {} };
    },
    throwIfCancelled(): void {},
  });

  private readonly controller: AbortController;
  private readonly callbacks = new Set<() => void>();
  private cancelled = false;

  constructor(controller?: AbortController) {
    this.controller = controller ?? new AbortController();
    // 外部 controller 可能预先 abort；同步初始化状态
    if (this.controller.signal.aborted) {
      this.cancelled = true;
    } else {
      this.controller.signal.addEventListener(
        'abort',
        () => {
          this.onAborted();
        },
        { once: true },
      );
    }
  }

  /** 用外部 AbortSignal 构造 token（任一触发即取消） */
  static from(signal: AbortSignal): CancellationToken {
    const ctl = new AbortController();
    if (signal.aborted) {
      ctl.abort();
    } else {
      signal.addEventListener(
        'abort',
        () => {
          ctl.abort();
        },
        { once: true },
      );
    }
    return new CancellationToken(ctl);
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** 导出底层 AbortSignal，便于与 fetch / 子代理桥接 */
  toAbortSignal(): AbortSignal {
    return this.controller.signal;
  }

  /** 触发取消；幂等。 */
  cancel(): void {
    if (this.cancelled) return;
    if (!this.controller.signal.aborted) {
      this.controller.abort();
    } else {
      this.onAborted();
    }
  }

  /**
   * 注册取消回调。
   * - 若已取消，回调**同步**执行一次（通过 queueMicrotask 保证 onCancel 调用点后）。
   * - 回调异常被 swallow，不会影响其他监听者。
   * - 返回 Disposable 可注销该回调。
   */
  onCancel(cb: () => void): Disposable {
    if (this.cancelled) {
      queueMicrotask(() => {
        safeInvoke(cb);
      });
      return { dispose(): void {} };
    }
    this.callbacks.add(cb);
    return {
      dispose: () => {
        this.callbacks.delete(cb);
      },
    };
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new CancellationError();
  }

  private onAborted(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    const cbs = Array.from(this.callbacks);
    this.callbacks.clear();
    for (const cb of cbs) safeInvoke(cb);
  }
}

function safeInvoke(cb: () => void): void {
  try {
    cb();
  } catch {
    // 忽略监听者异常，避免互相影响
  }
}
