/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Hooks 子系统 barrel export
 */
export * from './types.js';
export {
  loadHookConfig,
  parseHookConfig,
  type LoadHookConfigResult,
} from './config.js';
export { runHookCommand, type RunHookOptions } from './executor.js';
export {
  HookManager,
  createDefaultManager,
  nowMs,
  type HookManagerOptions,
} from './manager.js';
