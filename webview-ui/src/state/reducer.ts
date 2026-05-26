import type {
  HistoryMessage,
  ProviderStatusPayload,
  TaskEvent,
  CostSummaryPayload,
  SessionSummary,
  IndexProgressPayload,
  IndexStatusPayload,
  ModeStatusPayload,
  AskQuestionPayload,
  ApprovalRequestPayload,
  ToolDiffPayload,
  TodoItem,
} from '../protocol';

/* ─────────── 领域模型 ─────────── */

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface TextPart {
  kind: 'text';
  text: string;
  /**
   * 是否正在流式接收中（text_delta 陆续到来）。
   * 方案 B：流式期间由 StreamController DOM 直写，此标记仅用于 PartRenderer
   * 判断何时从占位容器切换到 MarkdownRenderer。
   */
  isStreaming?: boolean;
}

export interface ToolCallPart {
  kind: 'tool';
  toolCallId: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'error';
  argsPreview?: string;
  contentPreview?: string;
  errorCode?: string;
  /** W7b4b · 关联的 diff 快照（write_file / search_replace 产生） */
  diff?: ToolDiffPayload;
  /** W7b4b · 最近一次 revert 的状态（undefined = 未 revert） */
  revertState?: { ok: boolean; message?: string };
}

export type MessagePart = TextPart | ToolCallPart;

export interface UiMessage {
  id: string;
  role: MessageRole;
  parts: MessagePart[];
  reasoning?: string;
}

export interface UsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
}

/** W8.3 · Context 压缩状态快照 */
export interface ContextStatsSnapshot {
  level: 'none' | 'light' | 'medium' | 'heavy';
  originalTokens: number;
  compressedTokens: number;
  savingsPercent: number;
  inputBudget: number;
}

export type TaskStatus = 'idle' | 'running' | 'error';

/** W11.4 · 单条待打开的预览项 */
export interface PendingPreview {
  url: string;
  name: string;
  taskId: string;
  toolCallId: string;
}

export interface AppState {
  messages: UiMessage[];
  taskStatus: TaskStatus;
  currentTaskId?: string;
  /** 方案 B：当前流式消息的 streamId，由 turn_start 设置，用于 StreamController DOM 锚点绑定 */
  currentStreamMsgId?: string;
  currentSessionId?: string;
  lastError?: { code?: string; message?: string };
  lastUsage?: UsageSnapshot;
  /** W8.3 · 最后一次向 LLM 提交前的上下文压缩快照 */
  lastContextStats?: ContextStatsSnapshot;
  providerStatus?: ProviderStatusPayload;
  costSummary?: CostSummaryPayload;
  sessionList: SessionSummary[];
  indexProgress?: IndexProgressPayload;
  indexStatus?: IndexStatusPayload;
  modeStatus?: ModeStatusPayload;
  /** W7b4b · 当前 pending 的 ask_user_question；一次仅一个 */
  askQuestion?: AskQuestionPayload;
  /** 当前 pending 的审批请求；一次仅一个 */
  approvalRequest?: ApprovalRequestPayload;
  /** 等待审批的 toolCallId 集合（与 ToolCard 关联） */
  pendingApprovalToolIds: Set<string>;
  /** W7e4 · Agent 维护的 todo 列表 */
  todoList: TodoItem[];
  /** W-UI2 · 用户已 Accept 的文件 relPath 列表（Accept 是纯UI状态，不做 FS 操作） */
  acceptedFiles: string[];
  /** W-UI2 · 用户已 Reject 的文件 relPath 列表 */
  rejectedFiles: string[];
  /** W11.4 · run_preview 工具产生的待打开预览项 */
  pendingPreviews: PendingPreview[];
  /** W12.1 · 来自 extension 的 Inline Edit 草稿推送；Composer 按 nonce 变化一次性消费 */
  pendingPrefill?: { text: string; nonce: number; isInlineEdit?: boolean };
  /** W15.6 · 已被 revert 的 hunk nonce 集合 */
  revertedHunks: Set<string>;
}

export const initialState: AppState = {
  messages: [],
  taskStatus: 'idle',
  sessionList: [],
  todoList: [],
  acceptedFiles: [],
  rejectedFiles: [],
  pendingPreviews: [],
  pendingApprovalToolIds: new Set(),
  revertedHunks: new Set(),
};

/* ─────────── Actions ─────────── */

export type Action =
  | { type: 'USER_SEND'; text: string }
  | { type: 'TASK_EVENT'; event: TaskEvent }
  | { type: 'PROVIDER_STATUS'; payload: ProviderStatusPayload }
  | { type: 'HISTORY_RESET'; messages: HistoryMessage[]; sessionId?: string }
  | { type: 'COST_SUMMARY'; payload: CostSummaryPayload }
  | { type: 'SESSION_LIST'; sessions: SessionSummary[]; currentSessionId?: string }
  | { type: 'REINDEX_PROGRESS'; payload: IndexProgressPayload }
  | { type: 'INDEX_STATUS'; payload: IndexStatusPayload }
  | { type: 'MODE_STATUS'; payload: ModeStatusPayload }
  | { type: 'ASK_QUESTION'; payload: AskQuestionPayload }
  | { type: 'ASK_CLEAR' }
  | { type: 'APPROVAL_REQUEST'; payload: ApprovalRequestPayload }
  | { type: 'APPROVAL_CLEAR' }
  | { type: 'TOOL_DIFF'; payload: ToolDiffPayload }
  | { type: 'REVERT_RESULT'; checkpointId: string; ok: boolean; message?: string }
  | { type: 'REVERT_HUNK_RESULT'; nonce: string; ok: boolean; message?: string }
  | { type: 'TODO_LIST'; todos: TodoItem[] }
  | { type: 'ACCEPT_FILE'; relPath: string }
  | { type: 'ACCEPT_ALL'; relPaths: string[] }
  | { type: 'REJECT_FILE'; relPath: string }
  | { type: 'REJECT_ALL'; relPaths: string[] }
  | { type: 'PREVIEW_REQUEST'; payload: PendingPreview }
  | { type: 'PREVIEW_DISMISS'; toolCallId: string }
  | { type: 'PREFILL_INPUT'; text: string; nonce: number; isInlineEdit?: boolean }
  /** 方案 B：流结束，将最终文本注入 reducer，触发 MarkdownRenderer 切换 */
  | { type: 'TEXT_FINISH'; text: string };

/* ─────────── Reducer ─────────── */

let uid = 0;
const nextId = (prefix: string): string => `${prefix}-${Date.now()}-${++uid}`;

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'USER_SEND':
      return {
        ...state,
        taskStatus: 'running',
        messages: [
          ...state.messages,
          {
            id: nextId('u'),
            role: 'user',
            parts: [{ kind: 'text', text: action.text }],
          },
        ],
      };

    case 'PROVIDER_STATUS':
      return { ...state, providerStatus: action.payload };

    case 'HISTORY_RESET':
      return {
        ...state,
        currentSessionId: action.sessionId,
        // W-UI2 · 换 session / 清历史 时清空 acceptedFiles 和 rejectedFiles
        acceptedFiles: [],
        rejectedFiles: [],
        // 新建/切换会话时清除 todo、diff 预览、pending previews 等跨会话残留状态
        todoList: [],
        pendingPreviews: [],
        pendingApprovalToolIds: new Set(),
        revertedHunks: new Set(),
        messages: action.messages.map((m, i) => ({
          id: `hist-${i}`,
          role: (m.role as MessageRole) ?? 'assistant',
          parts: [{ kind: 'text', text: m.content }],
        })),
      };

    case 'COST_SUMMARY':
      return { ...state, costSummary: action.payload };

    case 'SESSION_LIST':
      return {
        ...state,
        sessionList: action.sessions,
        currentSessionId: action.currentSessionId ?? state.currentSessionId,
      };

    case 'REINDEX_PROGRESS':
      return { ...state, indexProgress: action.payload };

    case 'INDEX_STATUS':
      return { ...state, indexStatus: action.payload };

    case 'MODE_STATUS':
      return { ...state, modeStatus: action.payload };

    case 'ASK_QUESTION':
      return { ...state, askQuestion: action.payload };

    case 'ASK_CLEAR':
      return { ...state, askQuestion: undefined };

    case 'APPROVAL_REQUEST': {
      const nextIds = new Set(state.pendingApprovalToolIds);
      if (action.payload.toolCallId) nextIds.add(action.payload.toolCallId);
      // 同时更新对应 ToolCard 的状态为 running（显示审批按钮）
      const msgUpdated = updateToolPart(state, action.payload.toolCallId, (p) => ({
        ...p,
        status: 'running' as const,
        argsPreview: action.payload.argsPreview,
      }));
      return { ...msgUpdated, approvalRequest: action.payload, pendingApprovalToolIds: nextIds };
    }

    case 'APPROVAL_CLEAR': {
      const nextIds = new Set(state.pendingApprovalToolIds);
      if (state.approvalRequest?.toolCallId) nextIds.delete(state.approvalRequest.toolCallId);
      return { ...state, approvalRequest: undefined, pendingApprovalToolIds: nextIds };
    }

    case 'TOOL_DIFF':
      return updateToolPart(state, action.payload.toolCallId, (p) => ({
        ...p,
        diff: action.payload,
      }));

    case 'REVERT_RESULT':
      return patchToolByCheckpointId(state, action.checkpointId, {
        ok: action.ok,
        ...(action.message !== undefined ? { message: action.message } : {}),
      });

    case 'REVERT_HUNK_RESULT': {
      if (!action.ok) return state;
      const next = new Set(state.revertedHunks);
      next.add(action.nonce);
      return { ...state, revertedHunks: next };
    }

    case 'TODO_LIST':
      return { ...state, todoList: action.todos };

    case 'ACCEPT_FILE':
      if (state.acceptedFiles.includes(action.relPath)) return state;
      return {
        ...state,
        acceptedFiles: [...state.acceptedFiles, action.relPath],
        rejectedFiles: state.rejectedFiles.filter((p) => p !== action.relPath),
      };

    case 'ACCEPT_ALL': {
      const acceptSet = new Set([...state.acceptedFiles, ...action.relPaths]);
      const rejectSet = new Set(state.rejectedFiles);
      for (const p of action.relPaths) rejectSet.delete(p);
      return { ...state, acceptedFiles: Array.from(acceptSet), rejectedFiles: Array.from(rejectSet) };
    }

    case 'REJECT_FILE':
      if (state.rejectedFiles.includes(action.relPath)) return state;
      return {
        ...state,
        rejectedFiles: [...state.rejectedFiles, action.relPath],
        acceptedFiles: state.acceptedFiles.filter((p) => p !== action.relPath),
      };

    case 'REJECT_ALL': {
      const rejectSet = new Set([...state.rejectedFiles, ...action.relPaths]);
      const acceptSet = new Set(state.acceptedFiles);
      for (const p of action.relPaths) acceptSet.delete(p);
      return { ...state, acceptedFiles: Array.from(acceptSet), rejectedFiles: Array.from(rejectSet) };
    }

    case 'PREVIEW_REQUEST': {
      // 按 toolCallId 去重覆盖
      const rest = state.pendingPreviews.filter(
        (p) => p.toolCallId !== action.payload.toolCallId,
      );
      return { ...state, pendingPreviews: [...rest, action.payload] };
    }

    case 'PREVIEW_DISMISS':
      return {
        ...state,
        pendingPreviews: state.pendingPreviews.filter(
          (p) => p.toolCallId !== action.toolCallId,
        ),
      };

    case 'PREFILL_INPUT':
      return {
        ...state,
        pendingPrefill: { text: action.text, nonce: action.nonce, isInlineEdit: action.isInlineEdit },
      };

    case 'TASK_EVENT':
      return reduceTaskEvent(state, action.event);

    case 'TEXT_FINISH':
      return reduceTextFinish(state, action.text);

    default:
      return state;
  }
}

function reduceTaskEvent(state: AppState, ev: TaskEvent): AppState {
  switch (ev.type) {
    case 'task_start':
      return { ...state, currentTaskId: ev.taskId, taskStatus: 'running' };

    case 'turn_start':
      // 方案 B：StreamController 接管文本渲染，reducer 仍然记录消息结构，
      // 同时设置 currentStreamMsgId 供 MessageItem 做 DOM 锚点绑定
      return {
        ...state,
        currentStreamMsgId: `stream-${ev.taskId}-t${ev.turn}`,
        messages: [
          ...state.messages,
          { id: nextId('a'), role: 'assistant', parts: [{ kind: 'text', text: '', isStreaming: true }] },
        ],
      };

    case 'text_delta':
      // 方案 B：由 App.tsx → StreamController 接管 DOM 直写。
      // 此处作为 fallback（当 StreamController 未命中时仍保证文本不丢失）。
      return fallbackAppendTextDelta(state, ev.text);

    case 'reasoning_delta':
      return appendReasoning(state, ev.text);

    case 'tool_start':
      return appendToolCall(state, ev.toolCallId, ev.name);

    case 'tool_args_delta':
      return updateToolPart(state, ev.toolCallId, (p) => ({
        ...p,
        argsPreview: ev.partial,
      }));

    case 'tool_exec_start':
      return updateToolPart(state, ev.toolCallId, (p) => ({
        ...p,
        status: 'running',
        argsPreview: safeStringify(ev.args),
      }));

    case 'tool_exec_output':
      // W-UI6 · 实时追加工具中间输出（bash 终端输出流式推送）
      return updateToolPart(state, ev.toolCallId, (p) => {
        const append = ev.isDelta ? (p.contentPreview ?? '') + ev.contentPreview : ev.contentPreview;
        return { ...p, contentPreview: append };
      });

    case 'tool_exec_end':
      return updateToolPart(state, ev.toolCallId, (p) => ({
        ...p,
        status: ev.ok ? 'success' : 'error',
        // 保留流式累积的 contentPreview（isDelta 期间累积的实时输出），
        // 仅当之前无流式输出时才用 ev.contentPreview 兜底。
        // 避免 tool_exec_end 的截断 finalContent 覆盖用户已看到的终端实时输出。
        contentPreview: (p.contentPreview ?? '') || ev.contentPreview,
        errorCode: ev.errorCode,
      }));

    case 'usage':
      return {
        ...state,
        lastUsage: {
          promptTokens: ev.promptTokens,
          completionTokens: ev.completionTokens,
          cachedTokens: ev.cachedTokens,
        },
      };

    case 'context_stats':
      return {
        ...state,
        lastContextStats: {
          level: ev.level,
          originalTokens: ev.originalTokens,
          compressedTokens: ev.compressedTokens,
          savingsPercent: ev.savingsPercent,
          inputBudget: ev.inputBudget,
        },
      };

    case 'task_end':
      // 任务结束 → 清除 isStreaming + 清空 currentStreamMsgId
      return {
        ...finalizeStreaming(state),
        currentStreamMsgId: undefined,
        taskStatus: ev.reason === 'error' ? 'error' : 'idle',
        lastError:
          ev.reason === 'error'
            ? { code: ev.errorCode, message: ev.errorMessage }
            : undefined,
      };
  }
}

/**
 * fallbackAppendTextDelta — 当 StreamController 未命中时的兜底方案。
 * 简单地将文本追加到最后一条 assistant 消息的 text part。
 * 与方案 B 的 DOM 直写不同，此处不维护 streamingText。
 */
function fallbackAppendTextDelta(state: AppState, text: string): AppState {
  const messages = [...state.messages];
  const lastIdx = messages.length - 1;
  const lastMsg = messages[lastIdx];
  if (!lastMsg || lastMsg.role !== 'assistant') {
    return {
      ...state,
      messages: [
        ...messages,
        { id: nextId('a'), role: 'assistant', parts: [{ kind: 'text', text, isStreaming: true }] },
      ],
    };
  }
  const parts = [...lastMsg.parts];
  const tail = parts[parts.length - 1];
  if (tail && tail.kind === 'text') {
    parts[parts.length - 1] = { kind: 'text', text: tail.text + text, isStreaming: true };
  } else {
    parts.push({ kind: 'text', text, isStreaming: true });
  }
  messages[lastIdx] = { ...lastMsg, parts };
  return { ...state, messages };
}

/**
 * reduceTextFinish — 流结束，将最终文本写入最后一条 assistant 消息的 text part，
 * 关闭 isStreaming。配合 finalizeStreaming 完成 MarkdownRenderer 切换。
 */
function reduceTextFinish(state: AppState, text: string): AppState {
  const messages = [...state.messages];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const parts = [...msg.parts];
    let updated = false;
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j];
      if (p.kind === 'text') {
        parts[j] = { kind: 'text', text, isStreaming: false };
        updated = true;
        break;
      }
    }
    if (updated) {
      messages[i] = { ...msg, parts };
      return { ...state, messages };
    }
  }
  // fallback：如果没找到 assistant 消息，新加一条
  return {
    ...state,
    messages: [
      ...state.messages,
      { id: nextId('a'), role: 'assistant', parts: [{ kind: 'text', text }] },
    ],
  };
}

function appendReasoning(state: AppState, text: string): AppState {
  const messages = [...state.messages];
  const lastIdx = messages.length - 1;
  let lastMsg = messages[lastIdx];
  if (!lastMsg || lastMsg.role !== 'assistant') {
    lastMsg = {
      id: nextId('a'),
      role: 'assistant',
      parts: [{ kind: 'text', text: '' }],
    };
    messages.push(lastMsg);
    return { ...state, messages };
  }
  messages[lastIdx] = {
    ...lastMsg,
    reasoning: (lastMsg.reasoning ?? '') + text,
  };
  return { ...state, messages };
}

function appendToolCall(state: AppState, toolCallId: string, name: string): AppState {
  const messages = [...state.messages];
  const lastIdx = messages.length - 1;
  let lastMsg = messages[lastIdx];
  if (!lastMsg || lastMsg.role !== 'assistant') {
    lastMsg = {
      id: nextId('a'),
      role: 'assistant',
      parts: [],
    };
    messages.push(lastMsg);
  }
  const parts: MessagePart[] = [
    ...lastMsg.parts,
    { kind: 'tool', toolCallId, name, status: 'pending' },
  ];
  messages[messages.length - 1] = { ...lastMsg, parts };
  return { ...state, messages };
}

function updateToolPart(
  state: AppState,
  toolCallId: string,
  patcher: (p: ToolCallPart) => ToolCallPart,
): AppState {
  const messages = state.messages.map((msg) => {
    const idx = msg.parts.findIndex((p) => p.kind === 'tool' && p.toolCallId === toolCallId);
    if (idx === -1) return msg;
    const parts = [...msg.parts];
    parts[idx] = patcher(parts[idx] as ToolCallPart);
    return { ...msg, parts };
  });
  return { ...state, messages };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 根据 checkpointId 找到对应 ToolCallPart，写入 revertState */
function patchToolByCheckpointId(
  state: AppState,
  checkpointId: string,
  revertState: { ok: boolean; message?: string },
): AppState {
  const messages = state.messages.map((msg) => {
    const idx = msg.parts.findIndex(
      (p) => p.kind === 'tool' && p.diff?.checkpointId === checkpointId,
    );
    if (idx === -1) return msg;
    const parts = [...msg.parts];
    const target = parts[idx] as ToolCallPart;
    parts[idx] = { ...target, revertState };
    return { ...msg, parts };
  });
  return { ...state, messages };
}

/** 任务结束：清除所有 isStreaming 标记（方案 B：文本已由 TEXT_FINISH 写入） */
function finalizeStreaming(state: AppState): AppState {
  const messages: UiMessage[] = state.messages.map(function mapMsg(msg): UiMessage {
    const parts: MessagePart[] = msg.parts.map(function mapPart(p): MessagePart {
      if (p.kind === 'text' && p.isStreaming) {
        const out: TextPart = { kind: 'text', text: p.text };
        return out;
      }
      return p;
    });
    return { ...msg, parts };
  });
  return { ...state, messages };
}
