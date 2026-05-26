/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * LSP 模块 barrel export
 */
export type {
  LspBridge,
  LspLocation,
  LspPosition,
  LspRange,
  LspSymbol,
  LspSymbolKind,
  CallHierarchyEntry,
} from './bridge.js';
export { mapSymbolKind } from './bridge.js';
export { VSCodeLspBridge, type VSCodeLspBridgeOptions } from './vscode-bridge.js';
