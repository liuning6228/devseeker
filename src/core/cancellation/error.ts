/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * CancellationError —— 统一的取消异常（DESIGN §M15.4）
 *
 * 任何长操作在感知 token.isCancelled=true 时都应抛出此错误。
 * 上层 TaskLoop 捕获到它应被视为"用户主动停止"，而非业务失败。
 */

export class CancellationError extends Error {
  readonly code = 'CANCELLED' as const;
  readonly name = 'CancellationError' as const;

  constructor(message = 'Operation was cancelled') {
    super(message);
    // 保证 instanceof 在 ES5 target 下仍可用
    Object.setPrototypeOf(this, CancellationError.prototype);
  }
}

/** 类型守卫：判断任意 error 是否为取消异常 */
export function isCancellationError(e: unknown): e is CancellationError {
  return (
    e instanceof CancellationError ||
    (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'CANCELLED')
  );
}
