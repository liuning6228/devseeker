/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * cancellation 子系统 barrel export（DESIGN §M15.4）
 */

export { CancellationToken } from './token.js';
export type { ICancellationToken, Disposable } from './token.js';
export { CancellationError, isCancellationError } from './error.js';
