/**
 * Webview 侧消息协议类型
 *
 * 直接从共享真源 src/shared/protocol.ts 引入，避免类型漂移。
 * Vite 通过 resolve 能跨出 webview-ui 根目录读取 ../src/shared。
 */

export type {
  TaskEvent,
  WebviewInboundMessage,
  WebviewOutboundMessage,
  ProviderStatusPayload,
  HistoryMessage,
  CostSummaryPayload,
  SessionSummary,
  IndexProgressPayload,
  IndexStatusPayload,
  ModeStatusPayload,
  AskQuestionPayload,
  AskQuestionItem,
  AskQuestionOption,
  ApprovalRequestPayload,
  ToolDiffPayload,
  TodoItem,
  TodoListPayload,
  ModelLevelConfigPayload,
  ModelConfigPayload,
} from '../../src/shared/protocol';
