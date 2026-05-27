import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  CostSummaryPayload,
  HistoryMessage,
  ModelConfigPayload,
  ProviderStatusPayload,
  SessionSummary,
  TaskEvent,
  WebviewInboundMessage,
  WebviewOutboundMessage,
  IndexProgressPayload,
  IndexStatusPayload,
  ModeStatusPayload,
  AskQuestionPayload,
  ApprovalRequestPayload,
  ToolDiffPayload,
  TodoListPayload,
} from './protocol';
import { MessageList } from './components/MessageList';
import { Composer } from './components/Composer';
import { StatusBar, ContextBadge } from './components/StatusBar';
import { SessionDrawer } from './components/SessionDrawer';
import { QuestionCard } from './components/QuestionCard';
// import { ApprovalCard } from './components/ApprovalCard';
import { PreviewBanner } from './components/PreviewBanner';
import { TaskHeader } from './components/chat/TaskHeader.js';
import { ChangeSummary, aggregateChangedFiles } from './components/ChangeSummary';
import type { GearMenuAction } from './components/GearMenu';
import { ModelConfigPanel } from './components/ModelConfigPanel';
import { PlanSwitchBanner } from './components/PlanSwitchBanner';
import { reducer, initialState } from './state/reducer';
import { streamController } from './stream/StreamController';
import { useExtensionState, type View } from './context/ExtensionStateContext.js';
import { PlatformProvider } from './context/PlatformContext.js';
// Navbar 已合并到 StatusBar，不再使用
import { WelcomeView } from './components/welcome/WelcomeView.js';
import { OnboardingView } from './components/onboarding/OnboardingView.js';
import { SettingsView } from './components/settings/SettingsView.js';
import { HistoryView } from './components/history/HistoryView.js';
import { McpConfigurationView } from './components/mcp/configuration/McpConfigurationView.js';
// import { WorktreesView } from './components/worktrees/WorktreesView.js';
import { RulesView } from './components/rules/RulesView.js';
import './styles/model-config.css';

const vscode = acquireVsCodeApi();

function postToHost(msg: WebviewInboundMessage): void {
  vscode.postMessage(msg);
}

/** 非首次启动标志（localStorage） */
const FIRST_RUN_KEY = 'devSeeker.first_run_done';

export function App(): JSX.Element {
  const [showOnboarding, setShowOnboarding] = useState(() => {
    return !localStorage.getItem(FIRST_RUN_KEY);
  });

  const handleOnboardingComplete = (apiKey: string, model: string) => {
    // 配置通过 postMessage 写入 VSCode 设置
    postToHost({
      type: 'update_model_config',
      track: 'llm',
      level: 1,
      field: 'apiKey',
      value: apiKey,
    });
    // 更新 model（不带 apiKey 不会触发 provider 切换的自动 model 更新）
    postToHost({
      type: 'update_model_config',
      track: 'llm',
      level: 1,
      field: 'model',
      value: model,
    });
    localStorage.setItem(FIRST_RUN_KEY, '1');
    setShowOnboarding(false);
  };

  if (showOnboarding) {
    return (
      <div className="flex flex-col h-screen">
        <OnboardingView onComplete={handleOnboardingComplete} />
      </div>
    );
  }

  return (
    <AppWithNav />
  );
}

function AppWithNav(): JSX.Element {
  const { state, navigateTo } = useExtensionState();
  // showNavbar 不再使用（导航已合并到 StatusBar）
  const [localView, setLocalView] = useState<View>('chat');
  const currentView = state.currentView !== 'chat' && state.currentView !== 'welcome' ? state.currentView : localView;

  const handleNavigate = (view: View) => {
    navigateTo(view);
    setLocalView(view);
  };

  // handleTaskSelect 不再使用
  const handleSessionSelect = (sessionId: string) => {
    postToHost({ type: 'load_session', sessionId });
    handleNavigate('chat');
  };

  return (
    <PlatformProvider>
      <div className="flex flex-col h-screen">
        {/* 视图内容 */}
        <div className="flex-1 overflow-hidden">
          {currentView === 'welcome' && (
            <WelcomeView
              onTaskSelect={(prompt) => {
                postToHost({ type: 'send_user_input', text: prompt });
                handleNavigate('chat');
              }}
              onSessionSelect={handleSessionSelect}
              onBackToChat={() => handleNavigate('chat')}
              recentSessions={state.sessionList.map((s) => ({
                id: s.id,
                title: s.title,
                updatedAt: s.updatedAt,
              }))}
            />
          )}
          {currentView === 'chat' && (
            <AppInner onNavigate={handleNavigate} currentView={currentView} />
          )}
          {currentView === 'settings' && (
            <SettingsView onBack={() => handleNavigate('chat')} />
          )}
          {currentView === 'history' && (
            <HistoryView
              sessions={state.sessionList.map((s) => ({
                id: s.id,
                title: s.title,
                createdAt: (s as any).createdAt ?? s.updatedAt,
                updatedAt: s.updatedAt,
                messageCount: s.messageCount,
              }))}
              onLoadSession={(id) => {
                postToHost({ type: 'load_session', sessionId: id });
                handleNavigate('chat');
              }}
              onDeleteSession={(id) => postToHost({ type: 'delete_session', sessionId: id })}
              onBack={() => handleNavigate('chat')}
            />
          )}
          {currentView === 'mcp' && (
            <McpConfigurationView onBack={() => handleNavigate('chat')} />
          )}
          {currentView === 'rules' && (
            <RulesView onBack={() => handleNavigate('chat')} />
          )}
        </div>
        {/* 导航按钮已合并到 StatusBar（聊天视图内 StatusBar 含首页/历史按钮） */}
        {/* 不再使用底部 Navbar */}
      </div>
    </PlatformProvider>
  );
}

/** 占位视图 */
const NOOP_PLACEHOLDER = null as unknown as React.FC<{onBack?: () => void}>;

function AppInner({ onNavigate, currentView }: { onNavigate: (view: View) => void; currentView: View }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);
  const readyPostedRef = useRef(false);
  // W-UI4 · 会话历史抽屉可见性
  const [drawerVisible, setDrawerVisible] = useState(true);
  // W-UI6 · 索引大条
  const [indexBarExpanded, setIndexBarExpanded] = useState(false);
  const [showModelConfig, setShowModelConfig] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfigPayload | null>(null);

  useEffect(() => {
    if (readyPostedRef.current) return;
    readyPostedRef.current = true;
    postToHost({ type: 'ready' });
  }, []);

  // 当前流式消息 ID
  const streamMsgIdRef = useRef<string | null>(null);

  useEffect(() => {
    function onMessage(ev: MessageEvent<WebviewOutboundMessage>): void {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'task_event': {
          const event = msg.event as TaskEvent;

          // turn_start 时注册 StreamController 会话
          if (event.type === 'turn_start') {
            const sid = `stream-${event.taskId}-t${event.turn}`;
            streamMsgIdRef.current = sid;
            streamController.register(sid);
          }

          // text_delta — DOM 直写，跳过 React
          if (event.type === 'text_delta' && streamMsgIdRef.current) {
            streamController.append(streamMsgIdRef.current, event.text);
            break;
          }

          // task_end 时：先完成 StreamController，再 dispatch
          if (event.type === 'task_end') {
            const sid = streamMsgIdRef.current;
            if (sid) {
              const finalText = streamController.finish(sid);
              if (finalText !== undefined) {
                dispatch({ type: 'TEXT_FINISH', text: finalText });
              }
              streamMsgIdRef.current = null;
            }
          }

          dispatch({ type: 'TASK_EVENT', event });
          break;
        }
        case 'provider_status':
          dispatch({
            type: 'PROVIDER_STATUS',
            payload: msg.payload as ProviderStatusPayload,
          });
          break;
        case 'history':
          // 方案 B：会话切换/清空历史 → 清理 StreamController 残留会话
          streamController.resetAll();
          streamMsgIdRef.current = null;
          dispatch({
            type: 'HISTORY_RESET',
            messages: msg.messages as HistoryMessage[],
            sessionId: msg.sessionId,
          });
          break;
        case 'cost_summary':
          dispatch({
            type: 'COST_SUMMARY',
            payload: msg.payload as CostSummaryPayload,
          });
          break;
        case 'session_list':
          dispatch({
            type: 'SESSION_LIST',
            sessions: msg.sessions as SessionSummary[],
            currentSessionId: msg.currentSessionId,
          });
          break;
        case 'reindex_progress':
          dispatch({
            type: 'REINDEX_PROGRESS',
            payload: msg.payload as IndexProgressPayload,
          });
          break;
        case 'index_status':
          dispatch({
            type: 'INDEX_STATUS',
            payload: msg.payload as IndexStatusPayload,
          });
          break;
        case 'mode_status':
          dispatch({
            type: 'MODE_STATUS',
            payload: msg.payload as ModeStatusPayload,
          });
          break;
        case 'ask_question':
          dispatch({
            type: 'ASK_QUESTION',
            payload: msg.payload as AskQuestionPayload,
          });
          break;
        case 'approval_request':
          dispatch({
            type: 'APPROVAL_REQUEST',
            payload: msg.payload as ApprovalRequestPayload,
          });
          break;
        case 'tool_diff':
          dispatch({
            type: 'TOOL_DIFF',
            payload: msg.payload as ToolDiffPayload,
          });
          break;
        case 'revert_step_result':
          dispatch({
            type: 'REVERT_RESULT',
            checkpointId: msg.checkpointId,
            ok: msg.ok,
            ...(msg.message !== undefined ? { message: msg.message } : {}),
          });
          break;
        case 'revert_hunk_result':
          dispatch({
            type: 'REVERT_HUNK_RESULT',
            nonce: msg.nonce,
            ok: msg.ok,
            ...(msg.message !== undefined ? { message: msg.message } : {}),
          });
          break;
        case 'todo_list':
          dispatch({
            type: 'TODO_LIST',
            todos: (msg.payload as TodoListPayload).todos,
          });
          break;
        case 'model_config':
          setModelConfig(msg.payload as ModelConfigPayload);
          break;
        case 'preview_request':
          dispatch({
            type: 'PREVIEW_REQUEST',
            payload: {
              url: msg.url,
              name: msg.name,
              taskId: msg.taskId,
              toolCallId: msg.toolCallId,
            },
          });
          break;
        case 'prefill_input':
          dispatch({
            type: 'PREFILL_INPUT',
            text: msg.text,
            nonce: msg.nonce,
            isInlineEdit: msg.isInlineEdit,
          });
          break;
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const handleSend = useCallback((text: string, images?: string[]) => {
    const trimmed = text.trim();
    if (!trimmed && (!images || images.length === 0)) return;
    dispatch({ type: 'USER_SEND', text: trimmed });
    // W7c · 有图则带上 images（DataURL 数组）透传给扩展端
    postToHost(
      images && images.length > 0
        ? { type: 'send_user_input', text: trimmed, images }
        : { type: 'send_user_input', text: trimmed },
    );
  }, []);

  const handleAbort = useCallback(() => {
    postToHost({ type: 'abort' });
  }, []);

  const handleOpenSettings = useCallback(() => {
    postToHost({ type: 'open_settings' });
  }, []);

  const handleOpenModelConfig = useCallback(() => {
    setShowModelConfig(true);
    postToHost({ type: 'open_model_config' });
  }, []);

  const handleCloseModelConfig = useCallback(() => {
    setShowModelConfig(false);
  }, []);

  const handleNewSession = useCallback(() => {
    postToHost({ type: 'new_session' });
  }, []);

  const handleLoadSession = useCallback((sessionId: string) => {
    postToHost({ type: 'load_session', sessionId });
  }, []);

  const handleDeleteSession = useCallback((sessionId: string) => {
    postToHost({ type: 'delete_session', sessionId });
  }, []);

  const handleSelectProvider = useCallback((providerId: string | null) => {
    postToHost({ type: 'set_preferred_provider', providerId });
  }, []);

  const handleSelectMode = useCallback(
    (mode: 'agent' | 'plan' | 'debug' | 'ask') => {
      postToHost({ type: 'set_mode', mode });
    },
    [],
  );

  /** Plan 模式下用户点击"切换到 Agent 执行"按钮 */
  const handleSwitchToAgent = useCallback(() => {
    postToHost({ type: 'switch_to_agent_after_plan' });
  }, []);

  const handleAnswerAsk = useCallback(
    (
      requestId: string,
      answers: Array<{ question: string; selected: string[]; other?: string }>,
    ) => {
      postToHost({ type: 'ask_question_response', requestId, answers });
      dispatch({ type: 'ASK_CLEAR' });
    },
    [],
  );

  const handleCancelAsk = useCallback((requestId: string) => {
    postToHost({ type: 'ask_question_response', requestId, answers: [], cancelled: true });
    dispatch({ type: 'ASK_CLEAR' });
  }, []);

  const handleApprovalResponse = useCallback(
    (requestId: string, decision: 'allow_once' | 'remember' | 'deny' | 'redirect_terminal') => {
      postToHost({ type: 'approval_response', requestId, decision });
      dispatch({ type: 'APPROVAL_CLEAR' });
    },
    [],
  );

  /** 内联审批：从 ToolCard 点击同意/拒绝，携带 toolCallId 映射回 requestId */
  const handleApprovalResponseWithToolCallId = useCallback(
    (_toolCallId: string, decision: 'allow_once' | 'remember' | 'deny' | 'redirect_terminal') => {
      // 当前 approvalRequest 的 toolCallId 应匹配；直接复用已有的 requestId
      if (state.approvalRequest) {
        handleApprovalResponse(state.approvalRequest.requestId, decision);
      }
    },
    [state.approvalRequest, handleApprovalResponse],
  );

  const handleRevertStep = useCallback((checkpointId: string) => {
    postToHost({ type: 'revert_step', checkpointId });
  }, []);

  /** W9.14 · Markdown file:/// 链接点击 → 发给 host 打开文件 */
  const handleOpenFile = useCallback(
    (req: { path: string; lineStart?: number; lineEnd?: number }) => {
      postToHost({
        type: 'open_file',
        path: req.path,
        ...(req.lineStart !== undefined ? { lineStart: req.lineStart } : {}),
        ...(req.lineEnd !== undefined ? { lineEnd: req.lineEnd } : {}),
      });
    },
    [],
  );

  /** W-UI5 · bash 工具卡「在终端打开」：把命令预填到 VS Code 原生终端（不自动回车） */
  const handleOpenTerminal = useCallback((command: string) => {
    if (!command) return;
    postToHost({ type: 'open_terminal', command });
  }, []);

  /** W15.6 · hunk 级 Revert（发送给 extension 执行精确回滚） */
  const handleRevertHunk = useCallback((relPath: string, hunkUnified: string, nonce: string) => {
    postToHost({ type: 'revert_hunk', relPath, hunkUnified, nonce });
  }, []);

  /** W11.4 · 打开预览 URL（交给 host 用 vscode.env.openExternal） */
  const handleOpenPreview = useCallback((url: string, toolCallId: string) => {
    postToHost({ type: 'open_preview', url });
    dispatch({ type: 'PREVIEW_DISMISS', toolCallId });
  }, []);

  const handleDismissPreview = useCallback((toolCallId: string) => {
    dispatch({ type: 'PREVIEW_DISMISS', toolCallId });
  }, []);

  const isRunning = state.taskStatus === 'running';

  const usageLine = useMemo(() => {
    const u = state.lastUsage;
    if (!u) return '';
    const parts = [`in ${u.promptTokens}`, `out ${u.completionTokens}`];
    if (u.cachedTokens && u.cachedTokens > 0) parts.push(`cached ${u.cachedTokens}`);
    return parts.join(' · ');
  }, [state.lastUsage]);

  const costLine = useMemo(() => {
    const c = state.costSummary;
    if (!c) return '';
    const parts: string[] = [];
    if (c.session.CNY > 0) parts.push(`¥${formatNumber(c.session.CNY)}`);
    if (c.session.USD > 0) parts.push(`$${formatNumber(c.session.USD)}`);
    // W12.3 · Prompt Cache 命中率（当前会话→跨 provider 汇总）
    let cachedSum = 0;
    let promptSum = 0;
    for (const p of c.byProvider) {
      cachedSum += p.cachedTokens;
      promptSum += p.promptTokens;
    }
    const hitPart =
      promptSum > 0 && cachedSum > 0
        ? `cache ${Math.round((cachedSum / promptSum) * 100)}%`
        : '';
    if (parts.length === 0 && !hitPart) return '';
    const left = parts.length ? `本次 ${parts.join(' + ')}` : '';
    return [left, hitPart].filter(Boolean).join(' · ');
  }, [state.costSummary]);

  // W-UI2 · 消息流 tool 卡中提取的变更文件聚合（路径去重 + 行差累加）
  const changedFiles = useMemo(
    () => aggregateChangedFiles(state.messages),
    [state.messages],
  );

  // W-UI2 · 单文件 Accept：通知 extension 清除 inline diff 装饰
  const handleAcceptFile = useCallback((relPath: string) => {
    dispatch({ type: 'ACCEPT_FILE', relPath });
    postToHost({ type: 'accept_diff', relPath });
  }, []);

  // W-UI2 · Accept all：通知 extension 清除所有 inline diff 装饰
  const handleAcceptAll = useCallback((relPaths: string[]) => {
    dispatch({ type: 'ACCEPT_ALL', relPaths });
    postToHost({ type: 'accept_all_diffs' });
  }, []);

  // W-UI2 · 单文件 Reject：通知 extension 回滚该文件
  const handleRejectFile = useCallback((relPath: string) => {
    dispatch({ type: 'REJECT_FILE', relPath });
    // 查找该文件的 checkpointId
    const file = aggregateChangedFiles(state.messages).find((f) => f.relPath === relPath);
    postToHost({ type: 'reject_diff', relPath, checkpointId: file?.latestCheckpointId });
  }, [state.messages]);

  // W-UI2 · Reject all：通知 extension 回滚所有文件
  const handleRejectAll = useCallback((relPaths: string[]) => {
    dispatch({ type: 'REJECT_ALL', relPaths });
    const files = aggregateChangedFiles(state.messages)
      .filter((f) => relPaths.includes(f.relPath))
      .map((f) => ({ relPath: f.relPath, checkpointId: f.latestCheckpointId }));
    postToHost({ type: 'reject_all_diffs', files });
  }, [state.messages]);

  // ---------- W-UI4 · 齿轮菜单装配 ----------
  const cycleMode = useCallback(() => {
    const list = state.modeStatus?.available ?? [];
    if (list.length === 0) return;
    const cur = state.modeStatus?.current ?? list[0].id;
    const idx = list.findIndex((m) => m.id === cur);
    const next = list[(idx + 1) % list.length];
    postToHost({ type: 'set_mode', mode: next.id as 'agent' | 'plan' | 'debug' | 'ask' });
  }, [state.modeStatus]);

  const cycleProvider = useCallback(() => {
    const list = state.providerStatus?.availableProviders ?? [];
    if (list.length <= 1) return;
    const cur = state.providerStatus?.preferredProvider ?? '';
    // 循环顺序：'' (auto) → p0 → p1 → ... → ''
    const cycle: Array<string | null> = ['', ...list.map((p) => p.id)];
    const idx = cycle.findIndex((v) => v === cur);
    const nextRaw = cycle[(idx < 0 ? 0 : idx + 1) % cycle.length];
    const next = nextRaw === '' ? null : nextRaw;
    postToHost({ type: 'set_preferred_provider', providerId: next });
  }, [state.providerStatus]);

  const copyToClipboard = useCallback(async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // webview 环境下 navigator.clipboard 可能被禁，静默剔除（meta 里的文案仍可读取）
    }
  }, []);

  const currentModeLabel = state.modeStatus?.available?.find(m => m.id === state.modeStatus?.current)?.label ?? '智能体';
  /** Plan 模式下 plan 已就绪、展示"切换到 Agent"按钮 */
  const planReadyVisible = state.modeStatus?.current === 'plan' && state.modeStatus?.planReady === true;
  const currentProviderLabel =
    state.providerStatus?.preferredProvider
      ? state.providerStatus.preferredProvider
      : `auto(${state.providerStatus?.providerId ?? '-'})`;

  // W-UI4 · 齿轮菜单 8 项：Settings / Memory / Rules / Reindex / Export Session / Clear History / Check Updates / About
  const gearActions = useMemo<GearMenuAction[]>(
    () => [
      {
        id: 'settings',
        icon: '⚙️',
        label: '设置',
        onClick: handleOpenSettings,
      },
      // MCP 配置按钮已隐藏（MCP 协议打通不提升核心性能，暂不展示）
      // {
      //   id: 'mcp',
      //   icon: '🧩',
      //   label: 'MCP 配置',
      //   onClick: () => {
      //     onNavigate('mcp');
      //   },
      // },
      {
        id: 'rules',
        icon: '📜',
        label: '规则',
        onClick: () => {
          onNavigate('rules');
        },
        divider: true,
      },
      {
        id: 'memory',
        icon: '🧠',
        label: '记忆',
        onClick: () => postToHost({ type: 'open_memory' }),
      },
      {
        id: 'reindex',
        icon: '🔄',
        label: '重建索引',
        onClick: () => postToHost({ type: 'reindex' }),
        divider: true,
      },
      {
        id: 'export-session',
        icon: '📤',
        label: '导出会话',
        onClick: () => postToHost({ type: 'export_session' }),
      },
      {
        id: 'clear-history',
        icon: '🗑️',
        label: '清空历史',
        onClick: () => postToHost({ type: 'clear_history' }),
        divider: true,
      },
      {
        id: 'check-updates',
        icon: '📦',
        label: '检查更新',
        onClick: () => postToHost({ type: 'check_updates' }),
      },
      {
        id: 'about',
        icon: 'ℹ️',
        label: '关于',
        onClick: () => postToHost({ type: 'about' }),
      },
    ],
    [handleOpenSettings, onNavigate],
  );

  /**
   * W-UI6 · indexBar 默认收纳为 StatusBar 徽章；
   * 用户点击徽章 setIndexBarExpanded(true) 后展开大条（当前函数）。
   * 大条仍然只在「进行中」或「未建」时有内容，否则返回 null。
   */
  const indexBarContent = useMemo(() => {
    const prog = state.indexProgress;
    const status = state.indexStatus;
    if (prog && prog.phase !== 'idle' && prog.phase !== 'done') {
      const pct =
        prog.chunksTotal > 0
          ? Math.round((prog.chunksDone / prog.chunksTotal) * 100)
          : prog.filesTotal > 0
            ? Math.round((prog.filesDone / prog.filesTotal) * 100)
            : 0;
      return (
        <div className="index-bar">
          <div className="index-bar__track">
            <div className="index-bar__fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="index-bar__text">
            {prog.message ?? `${prog.phase}… ${pct}%`}
          </span>
          <button
            type="button"
            className="index-bar__action index-bar__action--ghost"
            onClick={() => setIndexBarExpanded(false)}
            title="收起大条、只看徽章"
          >
            收起
          </button>
        </div>
      );
    }
    if (status && !status.ready) {
      // W7d3 · 三种无索引状态：已扫过=0(空工作区) / 未扫过(首次)
      const root = status.workspaceRoot;
      const emptyWorkspace = status.scannedButEmpty === true;
      if (emptyWorkspace) {
        return (
          <div className="index-bar index-bar--info">
            <span className="index-bar__text">
              当前工作区无源码文件，无需建索引。语义搜索（search_codebase）在本工作区不可用，其他功能正常。
              {root && (
                <>
                  {' '}路径：<code className="index-bar__path">{root}</code>
                </>
              )}
            </span>
            <button
              type="button"
              className="index-bar__action index-bar__action--ghost"
              onClick={() => postToHost({ type: 'reindex' })}
              title="重新扫描（若你刚切换工作区或添加了源码文件）"
            >
              重新扫描
            </button>
          </div>
        );
      }
      // W7d2 · 有 workspaceRoot 就展示路径，帮用户自己判断"为啥扫不到文件"
      return (
        <div className="index-bar index-bar--hint">
          <span className="index-bar__text">
            代码库未索引。语义搜索（search_codebase）暂不可用。
            {root && (
              <>
                {' '}工作区：<code className="index-bar__path">{root}</code>
                。若跑完仍 0 files，请确认该路径是代码项目根（不是顶层聚合目录 / 压缩包目录）。
              </>
            )}
          </span>
          <button
            type="button"
            className="index-bar__action"
            onClick={() => postToHost({ type: 'reindex' })}
            title="等价于命令面板 DevSeeker: Reindex Codebase"
          >
            立即建索引
          </button>
        </div>
      );
    }
    return null;
  }, [state.indexProgress, state.indexStatus]);

  /** W-UI6 · StatusBar 小徽章：索引徽章（进行中/未建才显示）+ 子代理徽章（有活跃 Agent 工具时显示） */
  const statusBarBadges = useMemo(() => {
    const prog = state.indexProgress;
    const status = state.indexStatus;
    const items: JSX.Element[] = [];

    // 索引徽章
    if (prog && prog.phase !== 'idle' && prog.phase !== 'done') {
      const pct =
        prog.chunksTotal > 0
          ? Math.round((prog.chunksDone / prog.chunksTotal) * 100)
          : prog.filesTotal > 0
            ? Math.round((prog.filesDone / prog.filesTotal) * 100)
            : 0;
      items.push(
        <button
          key="idx"
          type="button"
          className="statusbar__badge statusbar__badge--index statusbar__badge--running"
          title={prog.message ?? `索引进行中·${prog.phase} ${pct}%（点击${indexBarExpanded ? '收起' : '展开'}大条）`}
          onClick={() => setIndexBarExpanded((v) => !v)}
        >
          🗂 {pct}%
        </button>,
      );
    } else if (status && !status.ready) {
      items.push(
        <button
          key="idx"
          type="button"
          className="statusbar__badge statusbar__badge--index statusbar__badge--warn"
          title={status.scannedButEmpty ? '当前工作区无源码文件·点击展开详情' : '索引未建·点击展开详情'}
          onClick={() => setIndexBarExpanded((v) => !v)}
        >
          🗂 {status.scannedButEmpty ? '无源码' : '未建'}
        </button>,
      );
    }

    // 子代理徽章：统计消息中 Agent 工具的活跃数
    let activeAgentCount = 0;
    for (const m of state.messages) {
      for (const p of m.parts) {
        if (p.kind === 'tool' && p.name === 'Agent' && (p.status === 'pending' || p.status === 'running')) {
          activeAgentCount += 1;
        }
      }
    }
    if (activeAgentCount > 0) {
      items.push(
        <span
          key="sub"
          className="statusbar__badge statusbar__badge--subagent"
          title={`当前有 ${activeAgentCount} 个子代理活跃（Agent 工具调用）`}
        >
          ⚡ 子代理 ×{activeAgentCount}
        </span>,
      );
    }

    return items.length > 0 ? <>{items}</> : null;
  }, [state.indexProgress, state.indexStatus, state.messages, indexBarExpanded]);

  /** W-UI6 · indexBar 最终显示：只有用户点开徽章时才显示大条 */
  const indexBar = indexBarExpanded ? indexBarContent : null;

  return (
    <div className="app flex flex-col flex-1 min-h-0 overflow-hidden">
      <StatusBar
        provider={state.providerStatus}
        gearActions={gearActions}
        badges={statusBarBadges}
        onNewSession={handleNewSession}
        onToggleDrawer={() => setDrawerVisible((v) => !v)}
        drawerVisible={drawerVisible}
        sessionCount={state.sessionList.length}
        onNavigate={onNavigate}
        currentView={currentView}
      />
      {indexBar}
      {showModelConfig && (
        <ModelConfigPanel
          config={modelConfig}
          onClose={handleCloseModelConfig}
          postMessage={postToHost}
        />
      )}
      <div className="app__body flex flex-1 min-h-0">
        {drawerVisible && (
          <SessionDrawer
            sessions={state.sessionList}
            currentSessionId={state.currentSessionId}
            onLoad={handleLoadSession}
            onDelete={handleDeleteSession}
          />
        )}
        <div className="app__main flex flex-col flex-1 min-w-0 min-h-0">
          {state.messages.length > 0 && (
            <TaskHeader
              userMessage={(() => {
                const first = state.messages.find(m => m.parts.some(p => p.kind === 'text'));
                return first?.parts.find(p => p.kind === 'text')?.text;
              })()}
              isRunning={isRunning}
              todoList={state.todoList}
            />
          )}
          <PlanSwitchBanner
            visible={planReadyVisible}
            onSwitchToAgent={handleSwitchToAgent}
          />
          <ChangeSummary
            todos={state.todoList}
            changedFiles={changedFiles}
            acceptedFiles={state.acceptedFiles}
            rejectedFiles={state.rejectedFiles}
            onOpenFile={handleOpenFile}
            onAcceptFile={handleAcceptFile}
            onAcceptAll={handleAcceptAll}
            onRejectFile={handleRejectFile}
            onRejectAll={handleRejectAll}
          />
          <MessageList messages={state.messages} onRevert={handleRevertStep} onOpenFile={handleOpenFile} onOpenTerminal={handleOpenTerminal} onRevertHunk={handleRevertHunk} revertedHunks={state.revertedHunks} pendingApprovalToolIds={state.pendingApprovalToolIds} onApprovalResponse={handleApprovalResponseWithToolCallId} currentStreamMsgId={state.currentStreamMsgId} riskLevel={state.approvalRequest?.riskLevel} />
        </div>
      </div>
      {/* 审批已内联到 ToolCard header 中，不再使用独立 ApprovalCard */}
      <PreviewBanner
        previews={state.pendingPreviews}
        onOpen={handleOpenPreview}
        onDismiss={handleDismissPreview}
      />
      <Composer
        disabled={false}
        isRunning={isRunning}
        onSend={handleSend}
        onAbort={handleAbort}
        prefill={state.pendingPrefill}
        provider={state.providerStatus}
        onSelectProvider={handleSelectProvider}
        mode={state.modeStatus}
        onSelectMode={handleSelectMode}
        cost={costLine}
        usage={usageLine}
        contextBadge={state.lastContextStats ? <ContextBadge stats={state.lastContextStats} /> : null}
        usedTokens={state.lastUsage?.promptTokens ?? 0}
        totalTokens={1048576}
      />
      {state.askQuestion && (
        <QuestionCard
          payload={state.askQuestion}
          onSubmit={handleAnswerAsk}
          onCancel={handleCancelAsk}
        />
      )}
    </div>
  );
}

function formatNumber(n: number): string {
  if (n < 0.0001) return '0';
  if (n < 0.01) return n.toFixed(5);
  if (n < 1) return n.toFixed(4);
  return n.toFixed(3);
}
