/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Problems 模块 barrel export（W7e1）
 */
export type {
  DiagnosticItem,
  DiagnosticSeverity,
  GetDiagnosticsOptions,
  ProblemsBridge,
} from './bridge.js';
export { SEVERITY_ORDER, mapSeverity } from './bridge.js';
export { VSCodeProblemsBridge, type VSCodeProblemsBridgeOptions } from './vscode-bridge.js';
