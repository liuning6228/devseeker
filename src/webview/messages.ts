/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Webview ↔ Extension 消息协议 re-export（单一真源在 src/shared/protocol.ts）
 */

export type {
  WebviewInboundMessage,
  WebviewOutboundMessage,
  ProviderStatusPayload,
  HistoryMessage,
  CostSummaryPayload,
  SessionSummary,
  IndexProgressPayload,
  IndexStatusPayload,
  ModeStatusPayload,
} from '../shared/protocol.js';
