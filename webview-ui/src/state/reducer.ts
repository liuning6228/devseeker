import type {
  HistoryMessage,
  ProviderStatusPayload,
  TaskEvent,
  CostSummaryPayload,
  SessionSummary,
  IndexProgressPayload,
  IndexStatusPayload,
  ModeStatusPayload,
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
  /** Step 9: Extension 侧开始时间戳 */
  startTime?: number;
  /** Step 9: 执行耗时 ms（Extension 侧端到端计算） */
  duration?: number;
  /** Agent 工具专用：子代理过程状态（由 subagent_event 累积，卡片渲染） */
  subagent?: SubagentState;
}

/** 子代理的单个工具步骤 */
export interface SubagentStep {
  name: string;
  toolId: string;
  status: 'running' | 'done' | 'error';
  /** 步骤开始时间戳（运行中步骤的实时耗时用） */
  startTime?: number;
  /** 步骤耗时 ms（完成后回填） */
  durationMs?: number;
}

/** 子代理过程状态（仅 UI，来自 Agent 工具的事件桥） */
export interface SubagentState {
  agentType: string;
  /** 派发描述（subagent_start 携带） */
  description: string;
  status: 'running' | 'done' | 'error';
  steps: SubagentStep[];
  /** 正文尾部（截断保留，避免无限增长） */
  textTail: string;
  /** 工具调用次数（由 subagent_end 终态确认） */
  toolCalls: number;
  /** 完成摘要（subagent_end 携带） */
  summary?: string;
  /** 子代理启动时间戳（已用时 / ETA 计算基准） */
  startTime?: number;
  /** 步数预算（def.maxTurns），进度与 ETA 估算用 */
  maxTurns?: number;
  /** 总耗时 ms（subagent_end 终态回填） */
  durationMs?: number;
}

export type MessagePart = TextPart | ToolCallPart;

export interface UiMessage {
  id: string;
  role: MessageRole;
  parts: MessagePart[];
  reasoning?: string;
  /**
   * 本消息所属轮次的流式会话 id（`stream-{taskId}-t{turn}`）。
   * 用于把 DOM 直写的流式文本在轮次/任务结束时**写回正确的消息**（多轮场景关键）。
   */
  streamId?: string;
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
  /** Step 4: 上下文中引用的文件/符号/记忆列表 */
  items?: ContextItemEntry[];
}

/** Step 4: 上下文条目 */
export interface ContextItemEntry {
  id: string;
  type: 'file' | 'symbol' | 'memory';
  name: string;
  path: string;
  estimatedTokens: number;
  recent?: boolean;
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
  lastError?: {
    code?: string;
    message?: string;
    /** Step 8: 错误分类 */
    category?: 'api' | 'network' | 'tool' | 'timeout' | 'auth' | 'unknown';
    /** Step 8: 修复建议 */
    suggestion?: string;
    /** Step 8: 能否重试 */
    retryable?: boolean;
  };
  lastUsage?: UsageSnapshot;
  /** W8.3 · 最后一次向 LLM 提交前的上下文压缩快照 */
  lastContextStats?: ContextStatsSnapshot;
  providerStatus?: ProviderStatusPayload;
  costSummary?: CostSummaryPayload;
  sessionList: SessionSummary[];
  indexProgress?: IndexProgressPayload;
  indexStatus?: IndexStatusPayload;
  modeStatus?: ModeStatusPayload;
  /** 最新一条待审批请求（兼容保留；完整集合见 pendingApprovals） */
  approvalRequest?: ApprovalRequestPayload;
  /**
   * 全部待审批请求：toolCallId → payload（单一事实源）。
   * 支撑：并发多审批不串扰 / 卡片缺失时覆盖层兜底 / 重放幂等归位。
   */
  pendingApprovals: Record<string, ApprovalRequestPayload>;
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
  /** Step 14: 工具调用 → 消息索引的映射（O(1) 查找） */
  toolCallIndex: Map<string, number>;
}

export const initialState: AppState = {
  messages: [],
  taskStatus: 'idle',
  sessionList: [],
  todoList: [],
  acceptedFiles: [],
  rejectedFiles: [],
  pendingPreviews: [],
  pendingApprovals: {},
  revertedHunks: new Set(),
  toolCallIndex: new Map(),
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
  | { type: 'APPROVAL_REQUEST'; payload: ApprovalRequestPayload }
  /** 单条审批结束（用户已作答）：按 toolCallId 或 requestId 精确移除 */
  | { type: 'APPROVAL_CLEAR'; toolCallId?: string; requestId?: string }
  /** 任务收尾：清空全部待审批 */
  | { type: 'APPROVAL_CLEAR_ALL' }
  | { type: 'TOOL_DIFF'; payload: ToolDiffPayload }
  | { type: 'REVERT_RESULT'; checkpointId: string; ok: boolean; message?: string }
  | { type: 'REVERT_HUNK_RESULT'; nonce: string; ok: boolean; message?: string }
  | { type: 'TODO_LIST'; todos: TodoItem[] }
  | { type: 'ACCEPT_FILE'; relPath: string }
  | { type: 'ACCEPT_ALL'; relPaths: string[] }
  | { type: 'REJECT_FILE'; relPath: string }
  | { type: 'REJECT_ALL'; relPaths: string[] }
  /** K5 · 拒绝回执：把“是否真回滚”写入 diff 卡（无 checkpoint 场景按 relPath 路由） */
  | { type: 'REJECT_RESULT'; relPath: string; ok: boolean; message?: string }
  | { type: 'PREVIEW_REQUEST'; payload: PendingPreview }
  | { type: 'PREVIEW_DISMISS'; toolCallId: string }
  | { type: 'PREFILL_INPUT'; text: string; nonce: number; isInlineEdit?: boolean }
  | { type: 'CLEAR_ERROR' }
  /**
   * 轮次收敛：把某轮流式文本写回对应消息（由 streamId 定位）。
   * 取代旧的 TEXT_FINISH（后者只能写"最后一条"，多轮场景会写错消息）。
   */
  | { type: 'TURN_FINALIZE'; streamId: string; text: string };

/* ─────────── Reducer ─────────── */

let uid = 0;
const nextId = (prefix: string): string => `${prefix}-${Date.now()}-${++uid}`;

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'USER_SEND':
      return {
        ...state,
        taskStatus: 'running',
        // 用户发送新消息时清除上一次的错误状态，避免旧错误横幅残留
        lastError: undefined,
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
        pendingApprovals: {},
        revertedHunks: new Set(),
        toolCallIndex: new Map(),
        // 清除残留的弹窗状态，避免会话切换后显示已取消的弹窗
        // （ask_user_question 弹窗由 AppWithNav 的 useState 持有，不在此 store 里）
        approvalRequest: undefined,
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

    case 'APPROVAL_REQUEST': {
      // 单一事实源：按 toolCallId 归位（多审批并发不再互相覆盖）
      const pendingApprovals = action.payload.toolCallId
        ? { ...state.pendingApprovals, [action.payload.toolCallId]: action.payload }
        : state.pendingApprovals;
      // 同时更新对应 ToolCard 状态为 running（内联审批面板）
      const msgUpdated = updateToolPart(state, action.payload.toolCallId, (p) => ({
        ...p,
        status: 'running' as const,
        argsPreview: action.payload.argsPreview,
      }));
      return { ...msgUpdated, pendingApprovals, approvalRequest: action.payload };
    }

    case 'APPROVAL_CLEAR': {
      const pendingApprovals = { ...state.pendingApprovals };
      for (const [tcId, payload] of Object.entries(pendingApprovals)) {
        if (
          (action.toolCallId !== undefined && tcId === action.toolCallId) ||
          (action.requestId !== undefined && payload.requestId === action.requestId)
        ) {
          delete pendingApprovals[tcId];
        }
      }
      const remaining = Object.values(pendingApprovals);
      return {
        ...state,
        pendingApprovals,
        approvalRequest: remaining.length > 0 ? remaining[remaining.length - 1] : undefined,
      };
    }

    case 'APPROVAL_CLEAR_ALL':
      return { ...state, pendingApprovals: {}, approvalRequest: undefined };

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

    case 'REJECT_RESULT': {
      // 拒绝回执（K5）：写入 revertState；失败时撤回“已拒绝”声明（UI 不能声称未发生的回滚）
      const patched = patchRevertStateByRelPath(state, action.relPath, {
        ok: action.ok,
        ...(action.message !== undefined ? { message: action.message } : {}),
      });
      if (action.ok) return patched;
      return { ...patched, rejectedFiles: patched.rejectedFiles.filter((p) => p !== action.relPath) };
    }

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

    case 'CLEAR_ERROR':
      return { ...state, taskStatus: 'idle', lastError: undefined };

    case 'TASK_EVENT':
      return reduceTaskEvent(state, action.event);

    case 'TURN_FINALIZE':
      return reduceTurnFinalize(state, action.streamId, action.text);

    default:
      return state;
  }
}

function reduceTaskEvent(state: AppState, ev: TaskEvent): AppState {
  switch (ev.type) {
    case 'task_start':
      return { ...state, currentTaskId: ev.taskId, taskStatus: 'running' };

    case 'turn_start': {
      // 方案 B：StreamController 接管文本渲染，reducer 记录消息结构 + 本轮的 streamId，
      // 供 MessageItem 做 DOM 锚点绑定与轮次收敛（TURN_FINALIZE）时定位消息。
      const streamId = `stream-${ev.taskId}-t${ev.turn}`;
      return {
        ...state,
        currentStreamMsgId: streamId,
        messages: [
          ...state.messages,
          {
            id: nextId('a'),
            role: 'assistant',
            streamId,
            parts: [{ kind: 'text', text: '', isStreaming: true }],
          },
        ],
      };
    }

    case 'text_delta':
      // 方案 B：由 App.tsx → StreamController 接管 DOM 直写。
      // 此处作为 fallback（当 StreamController 未命中时仍保证文本不丢失）。
      return fallbackAppendTextDelta(state, ev.text);

    case 'reasoning_delta':
      return appendReasoning(state, ev.text);

    case 'tool_start': {
      const withIndex = state.toolCallIndex.set(ev.toolCallId, state.messages.length - 1);
      return { ...appendToolCall(state, ev.toolCallId, ev.name), toolCallIndex: new Map(withIndex) };
    }

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
        startTime: ev.startTime, // Step 9
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
        duration: p.startTime && ev.endTime ? ev.endTime - p.startTime : undefined, // Step 9
      }));

    case 'subagent_event': {
      // 子代理过程事件（Agent 工具派生）→ 按 parentToolCallId 归位到对应卡片。
      // 仅 UI 旁路：不进入主消息流，也不影响 LLM history。
      const p = ev.progress;
      return updateToolPart(state, ev.parentToolCallId, (part) => {
        const prev: SubagentState = part.subagent ?? {
          agentType: ev.agentType,
          description: '',
          status: 'running',
          steps: [],
          textTail: '',
          toolCalls: 0,
        };
        switch (p.type) {
          case 'subagent_start':
            return {
              ...part,
              subagent: {
                ...prev,
                agentType: p.agentType,
                description: p.description,
                status: 'running',
                startTime: p.startTime,
                ...(p.maxTurns ? { maxTurns: p.maxTurns } : {}),
              },
            };
          case 'subagent_text':
            return { ...part, subagent: { ...prev, textTail: appendSubagentText(prev.textTail, p.text) } };
          case 'subagent_tool_start':
            return {
              ...part,
              subagent: {
                ...prev,
                steps: [
                  ...prev.steps,
                  {
                    name: p.name,
                    toolId: p.toolId,
                    status: 'running',
                    ...(p.startTime !== undefined ? { startTime: p.startTime } : {}),
                  },
                ],
              },
            };
          case 'subagent_tool_end':
            return {
              ...part,
              subagent: {
                ...prev,
                steps: prev.steps.map((s) =>
                  s.toolId === p.toolId
                    ? {
                        ...s,
                        status: p.ok ? ('done' as const) : ('error' as const),
                        ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
                      }
                    : s,
                ),
              },
            };
          case 'subagent_usage':
            // 成本记账由 extension 侧处理（panel.ts），卡片不展示
            return part;
          case 'subagent_end':
            return {
              ...part,
              subagent: {
                ...prev,
                status: p.ok ? 'done' : 'error',
                summary: p.summary,
                toolCalls: p.toolCalls,
                ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
              },
            };
          default:
            return part;
        }
      });
    }

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
          items: ev.items,
        },
      };

    case 'task_end': {
      // K3 终态收敛：任何结束时仍在 pending/running 的工具卡统一收敛，不留僵尸卡片。
      // （abort 检查在“每组工具开始前”，已声明未执行的调用永远没有 exec_end）
      const aborted = ev.reason === 'aborted';
      const maxTurns = ev.reason === 'max_turns';
      const converged: AppState = {
        ...state,
        messages: state.messages.map((msg) => {
          let changed = false;
          const parts = msg.parts.map((p) => {
            if (p.kind === 'tool' && (p.status === 'pending' || p.status === 'running')) {
              changed = true;
              return {
                ...p,
                status: 'error' as const,
                errorCode: maxTurns ? 'TASK.LOOP.INFINITE' : aborted ? 'TASK.LOOP.ABORTED' : 'TASK.LOOP.ENDED',
                contentPreview: maxTurns
                  ? '达到最大轮次，该工具调用未完成'
                  : aborted
                    ? '任务已中止，该工具调用未完成'
                    : '任务已结束，该工具调用未完成',
              };
            }
            return p;
          });
          return changed ? { ...msg, parts } : msg;
        }),
      };
      // 任务结束 → 清除 isStreaming + 清空 currentStreamMsgId + 清空待审批（K4：不再无人应答）
      return {
        ...finalizeStreaming(converged),
        currentStreamMsgId: undefined,
        pendingApprovals: {},
        approvalRequest: undefined,
        taskStatus: ev.reason === 'error' ? 'error' : 'idle',
        lastError:
          ev.reason === 'error'
            ? { code: ev.errorCode, message: ev.errorMessage }
            : undefined,
      };
    }

    default:
      return state;
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
/**
 * 轮次收敛：把某轮流式文本写回对应消息（按 streamId 定位）。
 * 硬约束：必须在 finalizeStreaming 之前调用（否则流式 part 已定型为空文本）。
 * 找不到对应消息（历史恢复/异常）时回退到"最后一条 assistant 文本 part"的旧行为。
 */
function reduceTurnFinalize(state: AppState, streamId: string, text: string): AppState {
  const messages = [...state.messages];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.streamId !== streamId) continue;
    const parts = [...msg.parts];
    const textIdx = parts.findIndex((p) => p.kind === 'text');
    const nextPart: MessagePart = { kind: 'text', text, isStreaming: false };
    if (textIdx >= 0) parts[textIdx] = nextPart;
    else parts.push(nextPart);
    messages[i] = { ...msg, parts };
    return { ...state, messages };
  }
  return reduceTextFinish(state, text);
}

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
    reasoning: capReasoning((lastMsg.reasoning ?? '') + text),
  };
  return { ...state, messages };
}

/** K7 有界：reasoning 在 UI 侧保留上限（保留尾部）；与子代理 textTail / H7 截断策略对齐 */
const REASONING_MAX_CHARS = 20_000;
const REASONING_TRUNCATED_MARK = '\n…[推理内容已截断]';

function capReasoning(text: string): string {
  if (text.length <= REASONING_MAX_CHARS) return text;
  return REASONING_TRUNCATED_MARK + text.slice(text.length - REASONING_MAX_CHARS);
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

/** 子代理卡片文本尾部保留上限（字符）：防止无限增长拖垮渲染 */
const SUBAGENT_TEXT_TAIL_MAX = 2000;

function appendSubagentText(prev: string, add: string): string {
  const next = prev + add;
  return next.length > SUBAGENT_TEXT_TAIL_MAX ? next.slice(next.length - SUBAGENT_TEXT_TAIL_MAX) : next;
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

/**
 * 按 relPath 定位 diff part 并写入 revertState。
 * 拒绝回执专用：H4 场景（无 checkpoint）无法按 checkpointId 路由。
 */
function patchRevertStateByRelPath(
  state: AppState,
  relPath: string,
  revertState: { ok: boolean; message?: string },
): AppState {
  const messages = state.messages.map((msg) => {
    const idx = msg.parts.findIndex((p) => p.kind === 'tool' && p.diff?.relPath === relPath);
    if (idx === -1) return msg;
    const parts = [...msg.parts];
    const target = parts[idx] as ToolCallPart;
    parts[idx] = { ...target, revertState };
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
