import React, { createContext, useContext, useReducer, useCallback, type ReactNode } from 'react';
import type { UiMessage, TaskStatus } from '../state/reducer.js';
import type { ProviderStatusPayload, CostSummaryPayload, IndexProgressPayload, IndexStatusPayload, ModeStatusPayload, ModelConfigPayload, TodoItem } from '../protocol.js';

// ─────────── 视图路由 ───────────

export type View = 'chat' | 'welcome' | 'onboarding' | 'history' | 'settings' | 'mcp' | 'rules';

// ─────────── Context 值类型 ───────────

export interface ExtensionState {
  // 视图路由
  currentView: View;

  // 会话
  messages: UiMessage[];
  taskStatus: TaskStatus | null;
  currentSessionId: string | null;
  taskId: string | null;

  // 模型
  providerStatus: ProviderStatusPayload | null;
  modelConfig: ModelConfigPayload | null;

  // 模式
  modeStatus: ModeStatusPayload | null;

  // 成本
  costSummary: CostSummaryPayload | null;

  // 索引
  indexProgress: IndexProgressPayload | null;
  indexStatus: IndexStatusPayload | null;

  // Todo
  todos: TodoItem[];

  // 加载状态
  ready: boolean;
  loading: boolean;

  // 会话列表
  sessionList: Array<{ id: string; title: string; updatedAt: number; messageCount: number }>;
}

type ExtensionAction =
  | { type: 'SET_VIEW'; view: View }
  | { type: 'SET_MESSAGES'; messages: UiMessage[] }
  | { type: 'APPEND_MESSAGE'; message: UiMessage }
  | { type: 'SET_TASK_STATUS'; status: TaskStatus | null }
  | { type: 'SET_TASK_ID'; taskId: string | null }
  | { type: 'SET_SESSION_ID'; sessionId: string | null }
  | { type: 'SET_PROVIDER_STATUS'; payload: ProviderStatusPayload }
  | { type: 'SET_MODEL_CONFIG'; payload: ModelConfigPayload }
  | { type: 'SET_MODE_STATUS'; payload: ModeStatusPayload }
  | { type: 'SET_COST_SUMMARY'; payload: CostSummaryPayload }
  | { type: 'SET_INDEX_PROGRESS'; payload: IndexProgressPayload }
  | { type: 'SET_INDEX_STATUS'; payload: IndexStatusPayload }
  | { type: 'SET_TODOS'; todos: TodoItem[] }
  | { type: 'SET_READY'; ready: boolean }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_SESSION_LIST'; sessions: ExtensionState['sessionList'] };

function extensionReducer(state: ExtensionState, action: ExtensionAction): ExtensionState {
  switch (action.type) {
    case 'SET_VIEW':
      return { ...state, currentView: action.view };
    case 'SET_MESSAGES':
      return { ...state, messages: action.messages };
    case 'APPEND_MESSAGE':
      return { ...state, messages: [...state.messages, action.message] };
    case 'SET_TASK_STATUS':
      return { ...state, taskStatus: action.status };
    case 'SET_TASK_ID':
      return { ...state, taskId: action.taskId };
    case 'SET_SESSION_ID':
      return { ...state, currentSessionId: action.sessionId };
    case 'SET_PROVIDER_STATUS':
      return { ...state, providerStatus: action.payload };
    case 'SET_MODEL_CONFIG':
      return { ...state, modelConfig: action.payload };
    case 'SET_MODE_STATUS':
      return { ...state, modeStatus: action.payload };
    case 'SET_COST_SUMMARY':
      return { ...state, costSummary: action.payload };
    case 'SET_INDEX_PROGRESS':
      return { ...state, indexProgress: action.payload };
    case 'SET_INDEX_STATUS':
      return { ...state, indexStatus: action.payload };
    case 'SET_TODOS':
      return { ...state, todos: action.todos };
    case 'SET_READY':
      return { ...state, ready: action.ready };
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    case 'SET_SESSION_LIST':
      return { ...state, sessionList: action.sessions };
    default:
      return state;
  }
}

const initialState: ExtensionState = {
  currentView: 'chat',
  messages: [],
  taskStatus: null,
  currentSessionId: null,
  taskId: null,
  providerStatus: null,
  modelConfig: null,
  modeStatus: null,
  costSummary: null,
  indexProgress: null,
  indexStatus: null,
  todos: [],
  ready: false,
  loading: false,
  sessionList: [],
};

interface ExtensionStateContextValue {
  state: ExtensionState;
  dispatch: React.Dispatch<ExtensionAction>;
  navigateTo: (view: View) => void;
}

const ExtensionStateContext = createContext<ExtensionStateContextValue | null>(null);

export function ExtensionStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(extensionReducer, initialState);

  const navigateTo = useCallback((view: View) => {
    dispatch({ type: 'SET_VIEW', view });
  }, []);

  return (
    <ExtensionStateContext.Provider value={{ state, dispatch, navigateTo }}>
      {children}
    </ExtensionStateContext.Provider>
  );
}

export function useExtensionState(): ExtensionStateContextValue {
  const ctx = useContext(ExtensionStateContext);
  if (!ctx) {
    throw new Error('useExtensionState must be used within ExtensionStateProvider');
  }
  return ctx;
}

export type { ExtensionAction };
