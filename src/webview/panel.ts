/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * DualMindChatPanel —— Webview 面板容器
 *
 * 职责（批次 4 扩展）：
 * - 管理 WebviewPanel 生命周期（单例）
 * - 桥接 Webview 消息 ↔ TaskLoop
 * - 通过 ModelRouter 选择 Provider；失败时自动 fallback
 * - 通过 CostTracker 实时计算成本并推送 UI
 * - 通过 SessionStore 持久化 / 恢复对话历史
 * - 在 apiKey 缺失时引导用户配置
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import { getWebviewHtml, genNonce } from './html.js';
import { parseUnifiedDiff } from '../core/diff/hunk-parser.js';
import { revertHunk } from '../core/diff/hunk-reverter.js';
import type {
  WebviewInboundMessage,
  WebviewOutboundMessage,
  CostSummaryPayload,
  SessionSummary,
  IndexProgressPayload,
  IndexStatusPayload,
  ModeStatusPayload,
} from './messages.js';
import type { AskQuestionItem, TodoItem, TodoListPayload, ModelConfigPayload, ModelLevelConfigPayload, ApprovalRequestPayload } from '../shared/protocol.js';
import { getProviderRegistry } from '../providers/registry.js';
import type { IProvider } from '../providers/base.js';
import type { Message, ProviderId } from '../providers/types.js';
import {
  type ProviderType,
  type ModelLevel,
  type ModelLevelConfig,
  PROVIDER_TYPES,
  PROVIDER_DEFAULTS,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_MODELS,
} from '../providers/model-config.js';
import { ModelRouter, shouldKeepVisionPolicy, hasVisionContent } from '../core/router/router.js';
import { detectReasoningNeed } from '../core/router/reasoning-probe.js';
import { CostTracker } from '../core/cost/tracker.js';
import { UsageJsonlStore } from '../core/cost/usage-store.js';
import {
  SessionStore,
  extractTitleFromMessages,
  newSessionId,
  type StoredSession,
} from '../core/session/store.js';
import {
  openSqliteDatabase,
  defaultSqlitePath,
  SqliteSessionStore,
  SqliteUsageStore,
  runLegacyMigrationIfNeeded,
  type SqliteDatabaseLike,
  InMemoryDb,
} from '../core/storage/index.js';
import { TaskLoop } from '../core/task/loop.js';
import { ToolRegistry, ToolRunner } from '../core/tools/registry.js';
import { classifyCommand } from '../core/tools/safety-classifier.js';
import {
  ReadFileTool,
  ListDirTool,
  WriteFileTool,
  AppendFileTool,
  DeleteFileTool,
  SearchReplaceTool,
  BashTool,
  SearchCodebaseTool,
  SearchKnowledgeTool,
  GoToDefinitionTool,
  FindReferencesTool,
  DocumentSymbolTool,
  WorkspaceSymbolTool,
  GoToImplementationTool,
  CallHierarchyTool,
  LspTool,
  GetProblemsTool,
  UpdateMemoryTool,
  SearchMemoryTool,
  FetchRulesTool,
  SkillTool,
  CreateSkillTool,
  CreateAgentTool,
  SwitchModeTool,
  CreatePlanTool,
  UpdatePlanTool,
  MemoryTool,
  SearchWebTool,
  FetchContentTool,
  ReadUrlTool,
  RunPreviewTool,
  type PreviewRequest,
  GitStatusTool,
  GitDiffTool,
  GitLogTool,
  AgentTool,
  TraceErrorTool,
  GrepCodeTool,
  TodoWriteTool,
} from '../core/tools/index.js';
import {
  AskUserQuestionTool,
  type AskUserQuestionResponse,
} from '../core/tools/ask_user_question.js';
import { makeUnifiedDiff, truncateUnifiedDiff } from '../core/tools/diff-utils.js';
import { VscodeTerminalManager, TerminalRegistry } from '../core/tools/vscode-terminal.js';
import { GetTerminalOutputTool } from '../core/tools/get_terminal_output.js';
import {
  CodebaseIndex,
  Bm25CodebaseIndex,
  DashScopeEmbedder,
  WorkerEmbedder,
  defaultIndexStorePath,
  defaultBm25IndexStorePath,
  type CodebaseIndexLike,
  type Embedder,
  type IndexProgress,
} from '../core/index/index.js';
import { KnowledgeIndex } from '../core/knowledge/index.js';
import { VSCodeLspBridge, type LspBridge } from '../core/lsp/index.js';
import { VSCodeProblemsBridge, type ProblemsBridge } from '../core/problems/index.js';
import { MemoryManager, BuiltinMemoryProvider, enhanceWithVectorMatch, renderTaskContextSection, buildFrozenSnapshot, PrefetchEngine } from '../core/memory/index.js';
import { formatApprovedPlanXml, appendPlanToSystemPrompt } from '../core/task/plan-injector.js';
import { SendMessageTool } from '../core/tools/send_message.js';
import { continuableRegistry } from '../core/subagent/index.js';
import { doesTaskNeedPlanning } from '../core/modes/decision-tree.js';
import type { MemoryRecord } from '../core/memory/index.js';
import { RuleLoader, selectForPrompt } from '../core/rules/index.js';
import type { Rule } from '../core/rules/index.js';
import { SkillLoader, BUILTIN_SKILLS, SkillDedupTracker } from '../core/skills/index.js';
import type { Skill } from '../core/skills/index.js';
import { AgentLoader } from '../core/agents/index.js';
import { HookManager, createDefaultManager, loadHookConfig } from '../core/hooks/index.js';
import type { HookSpec } from '../core/hooks/index.js';
import { ContextManager } from '../core/context/index.js';
import type { ToolApprovalGate } from '../core/tools/registry.js';
import { FileApprovalAuditSink } from '../core/tools/approval-audit.js';
import { loadApprovalPolicy } from '../core/tools/approval-policy-loader.js';
import { isEditTool, getBlockedMessage } from '../core/tools/debug-mode-gate.js';
import {
  ModeManager,
  MODE_INFO,
  ALL_MODES,
  isToolAllowedInMode,
  type Mode,
} from '../core/modes/index.js';
import {
  TavilyProvider,
  BochaProvider,
  BingProvider,
  DuckDuckGoProvider,
  ApiKeyPool,
  type ISearchProvider,
  type SearchProviderId,
  type ProviderRegistry as WebSearchRegistry,
} from '../core/web/index.js';
import type { SubagentRunnerDeps, SubagentInvocation, SubagentResult } from '../core/subagent/index.js';
import { runSubagent, createSubagentRegistry } from '../core/subagent/index.js';
import { PromptBuilder, buildEnvironmentBlock, buildGitContextBlock, buildFrameworkContext, buildVlmOcrBlock, defaultGitCtxRunner, type OpenTabInfo } from '../core/prompts/index.js';
import { clampImages } from '../core/image/image-clamp.js';
import { IndexFileWatcher } from '../core/index/watcher.js';
import { setIndexStatusBar } from '../ui/index-status-bar.js';
import {
  CheckpointCoordinator,
  CheckpointStore,
  TRACKED_WRITE_TOOLS,
  type CheckpointMeta,
  type RevertResult,
} from '../core/checkpoints/index.js';
import { getLogger } from '../infra/logger.js';
import { perfProbe } from '../infra/perf-probe.js';
import { AgentError, toAgentError, ErrorCodes, classifyErrorCode, FAILOVER_STRATEGY, type FailoverReason } from '../core/errors/index.js';
import { InlineEditHistory } from '../core/inline-edit/history.js';

const log = getLogger('webview.panel');

const VIEW_TYPE = 'devSeeker.chat';
const PREFERRED_PROVIDER_KEY = 'devSeeker.preferredProvider.v1';
// W7d3 · 记录上次 reindex 扫到的文件数（用于黄条识别"空工作区"）
const LAST_REINDEX_FILES_SCANNED_KEY = 'devSeeker.index.lastFilesScanned.v1';
// W7e4 · todo 列表持久化（workspaceState 天然绑定工作区，切换自动隔离）
const TODO_LIST_KEY = 'devSeeker.todoList.v1';
// B-P1-13 · M10.1 首轮标记：workspace_tree 仅在会话首轮注入，避免循环占用 token。
const HAS_EMITTED_WORKSPACE_TREE_KEY = 'devSeeker.hasEmittedWorkspaceTree.v1';

// W3.6 · DEFAULT_SYSTEM_PROMPT 已迁移到 src/core/prompts/layers/identity.ts（L0 层）
// 原地拼接逻辑由 PromptBuilder 负责，下方 buildSystemPrompt() 仅做数据采集。

export class DualMindChatPanel {
  static current: DualMindChatPanel | undefined;
  /** Phase 3 · 编辑器内联 hunk 装饰器（由 extension.ts 注入） */
  static inlineDiffController: import('../ui/inline-diff-decorator.js').InlineDiffController | undefined;
    static editorChangeBar: import('../ui/editor-change-bar.js').EditorChangeBar | undefined;
  /** 共享 SQLite 连接（由 extension.ts 打开后注入，避免双重加载 ~35MB WASM 内存） */
  static sharedSqliteDb: SqliteDatabaseLike | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly toolRegistry: ToolRegistry;
  private readonly router: ModelRouter;
  private readonly costTracker: CostTracker;
  private readonly sessionStore: SqliteSessionStore;
  private readonly usageStore: SqliteUsageStore;
  private sqliteDb: SqliteDatabaseLike;
  private readonly terminalManager: VscodeTerminalManager;

  private taskLoop: TaskLoop | null = null;
  /** 当前 session：未开始时 undefined；第一次 send 时创建 */
  private currentSession: StoredSession | undefined;
  /** 暂停上下文：暂停时保存，继续时消费 */
  private pausedContext: {
    userInput: string;
    images?: readonly string[];
    priorMessages: Message[];
    providerId: string;
    modelOverride?: string;
  } | null = null;
  /** B-P1-10 · 选区右键「Ask」积累的待注入片段；每次 buildSystemPrompt 读出后由调用方决定是否清空 */
  private pendingSelectedCodes: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    text: string;
  }> = [];
  /** B-P1-11 · 外部命令预先收集的 git 上下文块（已格式化） */
  private pendingGitContext: string | undefined;
  /** 当前任务所用 provider（Router 选出） */
  private activeProviderId: ProviderId | undefined;
  /** 代码库语义索引（懒加载） */
  private codebaseIndex: CodebaseIndexLike | undefined;
  private codebaseIndexPromise: Promise<CodebaseIndexLike> | undefined;
  /** W14.1 · 私有知识库索引（懒加载；与 codebase 分库） */
  private knowledgeIndex: KnowledgeIndex | undefined;
  private knowledgeIndexPromise: Promise<KnowledgeIndex> | undefined;
  /** LSP 桥接器（依赖 VSCode 工作区；未打开工作区时为 undefined） */
  private lspBridge: LspBridge | undefined;
  /** Problems 桥接器（依赖 VSCode workspaceRoot；未打开工作区时为 undefined） */
  private problemsBridge: ProblemsBridge | undefined;
  /** 分类记忆管理器（懒加载） */
  private memoryManager: MemoryManager | undefined;
  /** 项目规则加载器（懒加载） */
  private ruleLoader: RuleLoader | undefined;
  /** 项目技能加载器（懒加载） */
  private skillLoader: SkillLoader | undefined;
  /** W14.4 · 项目自定义 agents 加载器（懒加载） */
  private agentLoader: AgentLoader | undefined;
  /** W9.11 · ALREADY LOADED 防抖跟踪器（60s），会话生存期内单例 */
  private readonly skillDedup = new SkillDedupTracker();
  /** Hook 管理器（懒加载；W5） */
  private hookManager: HookManager | undefined;
  /** 会话内授权过的 external 工具名（审批门记忆） */
  private readonly approvedExternalTools = new Set<string>();
  /** Checkpoint 协调器（懒加载；W5b2b） */
  private checkpointCoordinator: CheckpointCoordinator | undefined;
  /** W12.1 · prefill 单调序号，用于 Composer 区分「这是新的一次 prefill」 */
  private prefillNonceSeq = 0;
  /** W15.4c · 下次 send 时是否应用 Inline Edit 约束（一次性消费） */
  private pendingInlineEdit = false;
  /** W15.4b · Inline Edit 历史（懒初始化，依赖 context.globalState） */
  private inlineEditHistory: InlineEditHistory | undefined;
  /** Mode 管理器（W6b1） */
  private readonly modeManager = new ModeManager();
  /** Debug Mode 强制取证门禁：本轮是否有取证操作记录 */
  private debugModeEvidence = false;
  /** Tavily 多 Key 池（单例，首次搜索时创建，配置变更时重建） */
  private tavilyKeyPool: ApiKeyPool | undefined;
  /** Bocha 多 Key 池（单例，首次搜索时创建，配置变更时重建） */
  private bochaKeyPool: ApiKeyPool | undefined;
  /** 上次创建 Pool 时用的 apiKeys 配置快照（用于检测配置变更） */
  private tavilyApiKeysSnapshot = '';
  private bochaApiKeysSnapshot = '';
  /** W7b4b · ask_user_question pending：requestId → resolve/reject */
  private readonly askPending = new Map<
    string,
    {
      resolve: (r: AskUserQuestionResponse) => void;
      reject: (e: Error) => void;
      onAbort: () => void;
      signal: AbortSignal;
    }
  >();
  /** 审批内联卡片 pending：requestId → resolve */
  private readonly approvalPending = new Map<
    string,
    {
      resolve: (r: { approved: boolean; remember?: boolean; redirected?: boolean }) => void;
      toolName: string;
      command?: string;
      cwd?: string;
    }
  >();
  /** 用户终端：用于「终端运行」/「↪终端」，整个会话只创建一个，复用 sendText */
  // 用户终端管理已移至 VscodeTerminalManager.runCommandOnUserTerminal
  /** W7b4b · 写类工具 diff 生成：toolCallId → { relPath, before, checkpoint promise } */
  private readonly pendingDiffs = new Map<
    string,
    {
      relPath: string;
      absPath: string;
      /** 工具执行前的 before 快照；undefined 表示文件不存在（create 场景） */
      before: string | undefined;
      checkpointPromise: Promise<string | undefined>;
    }
  >();
  /** Phase3 · 已恢复 diff 的 key 集合，防止 restoreDiffsForSession 重复推送 */
  private readonly restoredDiffKeys = new Set<string>();
  /** Plan 模式中 plan 已就绪，用户尚未切回 Agent（UI 头部展示"切换到 Agent"按钮） */
  private planReadyForSwitch = false;

  static async createOrShow(context: vscode.ExtensionContext): Promise<void> {
    // 优先在主编辑器列（当前活动编辑器所在列）打开，而非 Beside 侧边列。
    // 用户点击侧边栏图标期望进入当前对话窗口，而非分离的侧边面板。
    const column =
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;

    if (DualMindChatPanel.current) {
      DualMindChatPanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'DevSeeker', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
    });

    DualMindChatPanel.current = new DualMindChatPanel(panel, context);
    // v1.4.0 · sql.js 是异步初始化的（加载 WASM），在构造后异步完成 DB 初始化
    await DualMindChatPanel.current.initDb();
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    this.toolRegistry = new ToolRegistry();
    this.terminalManager = new VscodeTerminalManager();
    this.toolRegistry.register(new ReadFileTool());
    this.toolRegistry.register(new ListDirTool());
    this.toolRegistry.register(new WriteFileTool());
    this.toolRegistry.register(new AppendFileTool());
    this.toolRegistry.register(new DeleteFileTool());
    this.toolRegistry.register(new SearchReplaceTool());
    this.toolRegistry.register(new BashTool({ terminalManager: this.terminalManager }));
    this.toolRegistry.register(
      new GetTerminalOutputTool({ terminalManager: this.terminalManager }),
    );
    // search_codebase 工具注入闭包，以便动态获取当前索引
    this.toolRegistry.register(
      new SearchCodebaseTool({
        getIndex: () => this.codebaseIndex,
      }),
    );
    // W14.2 · search_knowledge 工具：懒加载私有知识库（.devseeker/knowledge/**/*.md）
    this.toolRegistry.register(
      new SearchKnowledgeTool({
        getIndex: () => this.getKnowledgeIndex(),
      }),
    );
    // LSP 工具：懒获取 bridge（打开工作区时才可用）
    const getLspBridge = () => this.getLspBridge();
    this.toolRegistry.register(new GoToDefinitionTool({ getBridge: getLspBridge }));
    this.toolRegistry.register(new FindReferencesTool({ getBridge: getLspBridge }));
    this.toolRegistry.register(new DocumentSymbolTool({ getBridge: getLspBridge }));
    this.toolRegistry.register(new WorkspaceSymbolTool({ getBridge: getLspBridge }));
    // W7e3 · LSP 高级操作：implementation + call hierarchy
    this.toolRegistry.register(new GoToImplementationTool({ getBridge: getLspBridge }));
    this.toolRegistry.register(new CallHierarchyTool({ getBridge: getLspBridge }));
    // B-P2-5 · 聚合 lsp 入口（分发到以上 6 个内部实现）
    this.toolRegistry.register(new LspTool({ getBridge: getLspBridge }));
    // S1 · trace_error 高层错误追溯工具（Debug Mode 优化）
    this.toolRegistry.register(new TraceErrorTool({ getBridge: getLspBridge }));
    // D5 · grep_code 工具：精确文本搜索（开箱即用，不需 LSP/索引）
    this.toolRegistry.register(new GrepCodeTool());
    // Problems 工具（W7e1）：懒获取 bridge（打开工作区时才可用）
    const getProblemsBridge = () => this.getProblemsBridge();
    this.toolRegistry.register(new GetProblemsTool({ getBridge: getProblemsBridge }));
    // 分类记忆工具：懒获取 manager（Phase 5 Phase A Step 3）
    const getMemoryManager = () => this.getMemoryManager() as any;
    this.toolRegistry.register(new UpdateMemoryTool({ getStore: getMemoryManager }));
    // Phase 5 Phase B · 新 memory 工具（替代 update_memory）
    this.toolRegistry.register(new MemoryTool({ getStore: getMemoryManager }));
    const getEmbedder = () => this.getCachedEmbedder();
    this.toolRegistry.register(new SearchMemoryTool({ getStore: getMemoryManager, getEmbedder }));
    // 项目规则工具：懒获取 loader
    const getRuleLoader = () => this.getRuleLoader();
    this.toolRegistry.register(new FetchRulesTool({ getLoader: getRuleLoader }));
    // 项目技能工具：懒获取 loader
    const getSkillLoader = () => this.getSkillLoader();
    this.toolRegistry.register(new SkillTool({ getLoader: getSkillLoader, dedup: this.skillDedup }));
    // W14.3 · create_skill：把对话沉淀为 .devseeker/skills/<slug>/SKILL.md
    this.toolRegistry.register(
      new CreateSkillTool({
        getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        onSkillCreated: (_absPath, _slug) => {
          // 刷新 SkillLoader 缓存，使下一次 skill 调用命中新创建的 skill
          this.skillLoader?.invalidate();
        },
      }),
    );
    // W14.4 · create_agent：把对话沉淀为 .devseeker/agents/<slug>/AGENT.md
    this.toolRegistry.register(
      new CreateAgentTool({
        getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        onAgentCreated: (_absPath, _slug) => {
          // 刷新 AgentLoader 缓存，使下一次 Agent 调用命中新创建的 agent
          this.agentLoader?.invalidate();
        },
      }),
    );
    // switch_mode 工具（W6b1）：请求切到 Plan 模式，用户批准后才生效
    this.toolRegistry.register(
      new SwitchModeTool({
        requestApproval: async ({ targetMode, explanation }) =>
          this.approveSwitchMode(targetMode, explanation),
      }),
    );
    // create_plan 工具（W6b2）：Plan 模式下产出计划文档
    this.toolRegistry.register(
      new CreatePlanTool({
        getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        getPlanDoc: () => this.modeManager.snapshot().planDoc,
        onPlanWritten: (absPath) => this.onPlanWritten(absPath),
      }),
    );
    // update_plan 工具（Phase 5 Phase A）：更新 plan 步骤状态
    this.toolRegistry.register(
      new UpdatePlanTool({
        getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      }),
    );
    // W6b3 联网工具：search_web / fetch_content / read_url
    //   ProviderRegistry 每次调用从最新 config 读 key，配置变更无需重启
    const getWebSearchRegistry = (): WebSearchRegistry => this.buildWebSearchRegistry();
    const getFetchDeps = () => this.buildFetchContentDeps();
    this.toolRegistry.register(new SearchWebTool({ getRegistry: getWebSearchRegistry }));
    this.toolRegistry.register(new FetchContentTool(getFetchDeps()));
    this.toolRegistry.register(new ReadUrlTool(getFetchDeps()));

    // W11.4 · run_preview：将本机 dev server URL 转给 webview，由用户点按钮打开
    this.toolRegistry.register(
      new RunPreviewTool({
        sink: (req) => this.pushPreviewRequest(req),
        requireLocalhost: true,
      }),
    );

    // W11.8 · Git 只读工具（status/diff/log）
    this.toolRegistry.register(new GitStatusTool());
    this.toolRegistry.register(new GitDiffTool());
    this.toolRegistry.register(new GitLogTool());

    // W6b4 Agent 工具：派生子代理（Browser/Research/Guide/Verify + 用户自定义）
    //   每次执行动态取当前 Provider 与 toolRegistry；子代理白名单不含 Agent → 天然防嵌套
    //   W14.4 · getRegistry 注入内置+自定义合成 registry
    this.toolRegistry.register(
      new AgentTool({
        getRunnerDeps: (): SubagentRunnerDeps => this.buildSubagentRunnerDeps(),
        getRegistry: () => this.getSubagentRegistry(),
      }),
    );

    // Phase 5 Phase D · SendMessageTool：与子代理继续通信
    this.toolRegistry.register(
      new SendMessageTool({
        findRunningAgent: (agentId) => {
          const entry = continuableRegistry.find(agentId);
          if (!entry) return undefined;
          return {
            resume: entry.resume,
            description: entry.description,
          };
        },
        registerContinuableAgent: (agentId, handler) => {
          continuableRegistry.register(agentId, handler.resume, handler.description, true);
        },
        unregisterContinuableAgent: (agentId) => {
          continuableRegistry.unregister(agentId);
        },
      }),
    );

    // W7b4b · ask_user_question：工具 await bridge，panel 推消息 + 等 response
    this.toolRegistry.register(
      new AskUserQuestionTool({
        bridge: (id, qs, sig) => this.requestAskQuestion(id, qs, sig),
      }),
    );

    // W7e4 · todo_write：workspaceState 持久化 + pushTodoList 通知 webview
    this.toolRegistry.register(
      new TodoWriteTool({
        getTodos: () => this.getTodos(),
        setTodos: (todos) => this.setTodosAndPush(todos),
      }),
    );

    // Provider Registry 初始化
    const config = vscode.workspace.getConfiguration('devSeeker');
    const registry = getProviderRegistry();
    registry.initFromConfig(config);

    // Router + CostTracker + SessionStore + UsageStore (W7b3)
    // B-P1-16 · 全线切换到 SQLite：一个 DB 连接 + 两个 Store + 一次性迁移
    // v1.4.0 · 构造时先用 InMemoryDb 占位，异步 initDb() 后替换为真实 sql.js 实例
    this.sqliteDb = new InMemoryDb();
    this.sessionStore = new SqliteSessionStore({ db: this.sqliteDb });
    this.usageStore = new SqliteUsageStore({ db: this.sqliteDb, dbPath: '' });
    this.costTracker = new CostTracker({
      initialTotalByProvider: [],
      sink: this.usageStore,
    });
    // 异步回填今日用量移至 initDb() 中
    this.router = new ModelRouter({
      providers: registry.list(),
      // 3 级降级链：defaultProviderId 不再需要，L1 即默认
      // 但保留旧 defaultProvider 兼容性，映射到 LLM L1
      defaultProviderId: undefined,
    });

    // Webview 内容
    const nonce = genNonce();
    this.panel.webview.html = getWebviewHtml(this.panel.webview, context.extensionUri, nonce);

    this.panel.webview.onDidReceiveMessage(
      (m) => this.onWebviewMessage(m as WebviewInboundMessage),
      undefined,
      this.disposables,
    );

    // 配置变更 → 重建 Provider Registry + Router（防抖 300ms，避免 ModelConfigPanel 连续写入时 Registry 风暴）
    let configDebounceTimer: ReturnType<typeof setTimeout> | undefined;
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (!e.affectsConfiguration('devSeeker')) return;
        if (configDebounceTimer) clearTimeout(configDebounceTimer);
        configDebounceTimer = setTimeout(() => {
          const cfg = vscode.workspace.getConfiguration('devSeeker');
          const reg = getProviderRegistry();
          reg.initFromConfig(cfg);
          this.router.update({
            providers: reg.list(),
            defaultProviderId: undefined,
          });
          this.pushProviderStatus();
          this.pushModelConfig();
          configDebounceTimer = undefined;
        }, 300);
      },
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // 注册文件保存监听器（增量索引）
    this.registerFileWatcher();
  }

  /**
   * v1.4.0 · 异步初始化 SQLite 数据库（加载 sql.js WASM）
   * 构造函数先用 InMemoryDb 占位，此方法完成后替换为真实的 sql.js 实例
   * 优先使用 extension.ts 已打开的共享连接（避免双重加载 ~70MB WASM 内存）
   */
  private async initDb(): Promise<void> {
    try {
      const workspaceRootForSqlite =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
        this.context.globalStorageUri.fsPath;
      const dbPath = defaultSqlitePath(workspaceRootForSqlite);

      let db: SqliteDatabaseLike;
      if (DualMindChatPanel.sharedSqliteDb) {
        db = DualMindChatPanel.sharedSqliteDb;
      } else {
        db = await openSqliteDatabase({ dbPath });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).sqliteDb = db;

      // 替换 store 为真实 SQLite 实例
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).sessionStore = new SqliteSessionStore({ db: this.sqliteDb });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).usageStore = new SqliteUsageStore({ db: this.sqliteDb, dbPath });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).costTracker = new CostTracker({
        initialTotalByProvider: this.sessionStore.loadTotalCost(),
        sink: this.usageStore,
      });

      // 从旧 memento + JSONL 迁移一次（幂等，已打标记则跳过）
      void runLegacyMigrationIfNeeded({
        db: this.sqliteDb,
        legacyMemento: this.context.workspaceState,
        legacyJsonlPath: new UsageJsonlStore().getFilePath(),
      }).catch(() => {
        /* 迁移失败不阻断启动 */
      });

      // 异步回填今日用量
      void this.usageStore.readAll().then((records) => {
        void this.costTracker.hydrateTodayFrom(records);
        this.pushCostSummary();
      });
    } catch (err) {
      // DB 初始化失败不崩溃，保留 InMemoryDb（功能受限但 UI 可用）
      log.error({ err: String(err) }, 'SQLite initDb failed, staying with InMemoryDb');
    }
  }

  private post(msg: WebviewOutboundMessage): void {
    try {
      const result = this.panel.webview.postMessage(msg);
      // postMessage 返回 Thenable<boolean>，需要 catch reject
      if (result && typeof result === 'object' && typeof result.then === 'function') {
        void result.then(undefined, () => { /* Webview disposed, ignore */ });
      }
    } catch {
      // Webview 已销毁，静默忽略（用户关闭了面板等场景）
    }
  }

  // ─────────── Provider 选择 + 状态推送 ───────────

  private getPreferredProviderId(): ProviderId | null {
    const v = this.context.workspaceState.get<string | null>(PREFERRED_PROVIDER_KEY, null);
    return v ?? null;
  }

  private async setPreferredProviderId(id: string | null): Promise<void> {
    await this.context.workspaceState.update(PREFERRED_PROVIDER_KEY, id);
  }

  private pushProviderStatus(): void {
    const registry = getProviderRegistry();
    const available = registry.listWithDisplayNames();
    const grouped = registry.listGroupedByTrack();
    const preferred = this.getPreferredProviderId();

    if (available.length === 0) {
      this.post({
        type: 'provider_status',
        payload: {
          ok: false,
          errorMessage:
            '未配置任何 Provider。请在 VSCode 设置中填入 devSeeker.models.llm.level1.apiKey',
          availableProviders: [],
          groupedProviders: { llm: [], vllm: [] },
          preferredProvider: preferred,
        },
      });
      return;
    }

    // 预览当前偏好对无 user 输入场景的选择
    const decision = this.router.pick({
      messages: [{ role: 'user', content: '' }],
      hint: preferred ? { preferredProvider: preferred } : undefined,
    });
    this.post({
      type: 'provider_status',
      payload: {
        ok: true,
        providerId: decision?.provider.id,
        availableProviders: available,
        groupedProviders: grouped,
        preferredProvider: preferred,
        routeReason: decision?.reason,
      },
    });
  }

  private pushCostSummary(): void {
    const s = this.costTracker.summary();
    const today = this.costTracker.todayCost();
    const payload: CostSummaryPayload = {
      session: { ...s.session },
      total: { ...s.total },
      today: { CNY: today.CNY, USD: today.USD },
      byProvider: s.byProvider.map((x) => ({ ...x })),
    };
    this.post({ type: 'cost_summary', payload });
  }

  // ─────────── 模型配置读写 ───────────

  /** 读取当前 VS Code 配置并推送给 Webview */
  private pushModelConfig(): void {
    const config = vscode.workspace.getConfiguration('devSeeker');
    const registry = getProviderRegistry();
    const modelsConfig = registry.readModelsConfigPublic(config);

    const toPayload = (c: ModelLevelConfig, track: 'llm' | 'vllm'): ModelLevelConfigPayload => ({
      provider: c.provider,
      model: c.model || (track === 'vllm' && PROVIDER_DEFAULTS[c.provider]?.vllmModel ? PROVIDER_DEFAULTS[c.provider].vllmModel! : PROVIDER_DEFAULTS[c.provider]?.model) || '',
      apiKeySet: !!(c.apiKey ?? '').trim() || (c.apiKeys?.length ?? 0) > 0,
      baseUrl: c.baseUrl || '',
      reasoningModel: c.reasoningModel || '',
      apiKeysCount: c.apiKeys?.length ?? 0,
    });

    const providerDefaults: ModelConfigPayload['providerDefaults'] = {};
    const providerModels: ModelConfigPayload['providerModels'] = {};
    for (const pt of PROVIDER_TYPES) {
      const def = PROVIDER_DEFAULTS[pt];
      providerDefaults[pt] = {
        model: def.model,
        reasoningModel: def.reasoningModel,
        baseUrl: def.baseUrl,
      };
      providerModels[pt] = PROVIDER_MODELS[pt] ?? [];
    }

    const payload: ModelConfigPayload = {
      llm: {
        level1: toPayload(modelsConfig.llm.level1, 'llm'),
        level2: modelsConfig.llm.level2 ? toPayload(modelsConfig.llm.level2, 'llm') : undefined,
        level3: modelsConfig.llm.level3 ? toPayload(modelsConfig.llm.level3, 'llm') : undefined,
      },
      vllm: {
        level1: toPayload(modelsConfig.vllm.level1, 'vllm'),
        level2: modelsConfig.vllm.level2 ? toPayload(modelsConfig.vllm.level2, 'vllm') : undefined,
        level3: modelsConfig.vllm.level3 ? toPayload(modelsConfig.vllm.level3, 'vllm') : undefined,
      },
      providerTypes: [...PROVIDER_TYPES],
      providerDefaults,
      providerModels,
      activeProviderId: this.activeProviderId,
      activeProviderOk: registry.get(this.activeProviderId ?? '') !== undefined,
    };

    this.post({ type: 'model_config', payload });
  }

  /** 即改即写：单个字段变更写入 VS Code 配置 */
  private handleUpdateModelConfig(
    track: 'llm' | 'vllm',
    level: 1 | 2 | 3,
    field: 'provider' | 'apiKey' | 'model' | 'baseUrl' | 'reasoningModel' | 'apiKeys',
    value: string | string[],
  ): void {
    const config = vscode.workspace.getConfiguration('devSeeker');
    const key = `models.${track}.level${level}.${field}`;
    log.info({ track, level, field, valueType: typeof value }, 'Updating model config');

    // 切换 provider 时，同步更新 model 为新 provider 的默认值（区分 LLM/VLLM）
    if (field === 'provider' && typeof value === 'string') {
      const newProvider = value as ProviderType;
      const defaults = PROVIDER_DEFAULTS[newProvider];
      const defaultModel = track === 'vllm' && defaults.vllmModel ? defaults.vllmModel : defaults.model;
      const modelKey = `models.${track}.level${level}.model`;
      const baseUrlKey = `models.${track}.level${level}.baseUrl`;

      // 同时写入 provider + model + baseUrl（一并更新避免 UI 闪烁）
      Promise.resolve(config.update(key, value || undefined, vscode.ConfigurationTarget.Global)).then(() => {
        return config.update(modelKey, defaultModel || undefined, vscode.ConfigurationTarget.Global);
      }).then(() => {
        return config.update(baseUrlKey, defaults.baseUrl || undefined, vscode.ConfigurationTarget.Global);
      }).then(() => {
        this.pushModelConfig();
      }).catch((err: unknown) => {
        log.error({ err: String(err), key }, 'Failed to update model config (provider switch)');
      });
      return;
    }

    config.update(key, value || undefined, vscode.ConfigurationTarget.Global).then(
      () => {
        this.pushModelConfig();
      },
      (err) => {
        log.error({ err: String(err), key }, 'Failed to update model config');
      },
    );
  }

  /** W11.4 · 推送 run_preview 请求给 webview */
  private pushPreviewRequest(req: PreviewRequest): void {
    this.post({
      type: 'preview_request',
      url: req.url,
      name: req.name,
      taskId: req.taskId,
      toolCallId: req.toolCallId,
    });
  }

  private pushSessionList(): void {
    const sessions: SessionSummary[] = this.sessionStore.listSessions().map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length,
    }));
    this.post({
      type: 'session_list',
      sessions,
      currentSessionId: this.currentSession?.id,
    });
  }

  private async pushIndexStatus(): Promise<void> {
    try {
      const idx = await this.getCodebaseIndex();
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const ready = idx.size() > 0;
      // W7d3 · 读取上次 reindex 的 filesScanned；若为 0 且当前仍空 → 标记 scannedButEmpty
      const lastFilesScanned = this.context.workspaceState.get<number | undefined>(
        LAST_REINDEX_FILES_SCANNED_KEY,
        undefined,
      );
      const scannedButEmpty = !ready && lastFilesScanned === 0;
      const fileCount = idx.listIndexedFiles().length;
      const payload: IndexStatusPayload = {
        ready,
        fileCount,
        modelId: undefined,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(scannedButEmpty ? { scannedButEmpty: true } : {}),
      };
      this.post({ type: 'index_status', payload });
      // B-1.0.1-D · 同步更新状态栏
      if (ready) {
        setIndexStatusBar('ready', { fileCount });
      } else if (scannedButEmpty) {
        setIndexStatusBar('empty', {
          fileCount: 0,
          message: '上次 Reindex 扫到 0 个文件，点击重试。',
        });
      } else {
        setIndexStatusBar('empty', { fileCount: 0 });
      }
    } catch {
      this.post({
        type: 'index_status',
        payload: { ready: false, fileCount: 0 },
      });
      setIndexStatusBar('error', { message: '读取索引状态失败。' });
    }
  }

  // ─────────── Webview 消息分发 ───────────

  private onWebviewMessage(msg: WebviewInboundMessage): void {
    switch (msg.type) {
      case 'ready':
        // W12.3 · 冷启动指标：webview DOM 就绪（距 activate 起点的毫秒数）
        perfProbe.markWebviewReady();
        this.pushProviderStatus();
        this.pushCostSummary();
        this.pushSessionList();
        this.pushIndexStatus();
        this.pushModeStatus();
        // W7e4 · 恢复上次持久化的 todo 列表
        this.pushTodoList(this.getTodos());
        // 首次打开尝试自动恢复最近 session
        this.tryRestoreLatestSession();
        break;

      case 'send_user_input':
        this.startTask(msg.text, msg.images).catch((e) => {
          const err = toAgentError(e);
          log.error({ code: err.code, msg: err.message }, 'startTask failed');
        });
        break;

      case 'abort':
        this.taskLoop?.abort();
        // W7b4a: Stop 按钮同时 kill 所有后台 session
        try {
          this.terminalManager.killAll();
        } catch {
          /* ignore */
        }
        break;

      case 'open_settings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'dualMind');
        break;

      case 'open_model_config':
        this.pushModelConfig();
        break;

      case 'update_model_config':
        this.handleUpdateModelConfig(msg.track, msg.level, msg.field, msg.value);
        break;

      case 'new_session':
        this.handleNewSession();
        break;

      case 'reindex':
        // W7c2 · 黄条"立即建索引"按钮 → 转到统一命令入口（与命令面板一致）
        void vscode.commands.executeCommand('devSeeker.reindex');
        break;

      case 'load_session':
        this.handleLoadSession(msg.sessionId).catch((e) =>
          log.error({ err: String(e) }, 'load_session failed'),
        );
        break;

      case 'delete_session':
        this.handleDeleteSession(msg.sessionId).catch((e) =>
          log.error({ err: String(e) }, 'delete_session failed'),
        );
        break;

      case 'set_preferred_provider':
        this.setPreferredProviderId(msg.providerId).then(() => this.pushProviderStatus());
        break;

      case 'set_mode':
        this.handleSetModeFromUser(msg.mode);
        break;

      case 'ask_question_response':
        this.handleAskQuestionResponse(msg.requestId, msg.answers, msg.cancelled);
        break;

      case 'approval_response':
        this.handleApprovalResponse(msg.requestId, msg.decision);
        break;

      case 'clear_history':
        this.handleClearHistory();
        break;

      case 'open_memory':
        this.handleOpenMemory();
        break;

      case 'export_session':
        this.handleExportSession();
        break;

      case 'check_updates':
        this.handleCheckUpdates();
        break;

      case 'about':
        this.handleAbout();
        break;

      case 'switch_to_agent_after_plan':
        this.handleSwitchToAgentAfterPlan();
        break;

      case 'revert_step':
        this.handleRevertStep(msg.checkpointId).catch((e) =>
          log.error({ err: String(e) }, 'revert_step failed'),
        );
        break;

      case 'revert_hunk':
        this.handleRevertHunk(msg.relPath, msg.hunkUnified, msg.nonce).catch((e) =>
          log.error({ err: String(e), nonce: msg.nonce }, 'revert_hunk failed'),
        );
        break;

      case 'accept_diff': {
        // W-UI2 · webview Accept 单文件 → 清除 inline diff 装饰 + 更新 EditorChangeBar
        if (DualMindChatPanel.inlineDiffController) {
          const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const absPath = wsRoot ? path.resolve(wsRoot, msg.relPath) : msg.relPath;
          const decorator = (DualMindChatPanel.inlineDiffController as any).decorators?.get(absPath) as any;
          if (decorator) {
            decorator.acceptAll();
          }
        }
        // 同步更新 EditorChangeBar：移除该文件
        if (DualMindChatPanel.editorChangeBar) {
          DualMindChatPanel.editorChangeBar.removeFile(msg.relPath);
        }
        // 清理该文件对应的 step checkpoint（不再需要回滚）
        this.cleanupCheckpointsOnAccept(msg.relPath).catch((e: unknown) =>
          log.warn({ err: String(e), relPath: msg.relPath }, 'accept_diff checkpoint cleanup failed'),
        );
        break;
      }

      case 'accept_all_diffs':
        // W-UI2 · webview Accept All → 清除所有 inline diff 装饰 + 清空 EditorChangeBar
        DualMindChatPanel.inlineDiffController?.acceptAllFiles();
        DualMindChatPanel.editorChangeBar?.clear();
        // 清理所有 step checkpoint（全量接受，不再需要回滚）
        this.cleanupAllStepCheckpoints().catch((e: unknown) =>
          log.warn({ err: String(e) }, 'accept_all_diffs checkpoint cleanup failed'),
        );
        break;

      case 'reject_diff': {
        // W-UI2 · webview Reject 单文件 → 回滚该文件 + 清除 inline diff 装饰 + 更新 EditorChangeBar
        if (msg.checkpointId) {
          this.handleRevertStep(msg.checkpointId).catch((e: unknown) =>
            log.error({ err: String(e), checkpointId: msg.checkpointId }, 'reject_diff revert failed'),
          );
        } else {
          log.warn({ relPath: msg.relPath }, 'reject_diff: no checkpointId, cannot revert');
        }
        // 清除 inline diff 装饰
        if (DualMindChatPanel.inlineDiffController) {
          const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const absPath = wsRoot ? path.resolve(wsRoot, msg.relPath) : msg.relPath;
          const decorator = (DualMindChatPanel.inlineDiffController as any).decorators?.get(absPath) as any;
          if (decorator) {
            decorator.rejectAll();
          }
        }
        // 同步更新 EditorChangeBar：移除该文件
        if (DualMindChatPanel.editorChangeBar) {
          DualMindChatPanel.editorChangeBar.removeFile(msg.relPath);
        }
        break;
      }

      case 'reject_all_diffs': {
        // W-UI2 · webview Reject All → 回滚所有文件 + 清除所有 inline diff 装饰 + 清空 EditorChangeBar
        const files = msg.files;
        for (const file of files) {
          if (file.checkpointId) {
            this.handleRevertStep(file.checkpointId).catch((e: unknown) =>
              log.error({ err: String(e), checkpointId: file.checkpointId }, 'reject_all_diffs revert failed'),
            );
          } else {
            log.warn({ relPath: file.relPath }, 'reject_all_diffs: no checkpointId for file, skipping');
          }
        }
        // 清除所有 inline diff 装饰
        DualMindChatPanel.inlineDiffController?.rejectAllFiles();
        // 清空 EditorChangeBar
        DualMindChatPanel.editorChangeBar?.clear();
        break;
      }

      case 'open_file':
        this.handleOpenFile(msg.path, msg.lineStart, msg.lineEnd).catch((e: unknown) =>
          log.error({ err: String(e) }, 'open_file failed'),
        );
        break;

      case 'open_preview':
        this.handleOpenPreview(msg.url).catch((e: unknown) =>
          log.error({ err: String(e) }, 'open_preview failed'),
        );
        break;

      case 'open_terminal':
        // 点击「↪终端」→ 在用户可见终端执行（fire-and-forget，不需等待返回）
        {
          const cmd = msg.command;
          if (cmd) {
            const cwd = msg.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            this.terminalManager.runCommandOnUserTerminal({
              command: cmd,
              cwd,
            }).catch((e: unknown) => {
              log.error({ err: String(e) }, 'open_terminal failed');
            });
          }
        }
        break;

      case 'get_inline_edit_history': {
        // W15.4b · 查询 Inline Edit 历史
        const hist = this.getInlineEditHistory();
        const records = hist.getRecent(msg.filePath, msg.limit);
        this.post({ type: 'inline_edit_history', records });
        break;
      }
    }
  }

  // ─────────── Session 生命周期 ───────────

  /**
   * 面板启动时尝试恢复最近会话。
   * 为避免「新建会话却显示旧内容」的困惑，当前策略改为：
   * 仅推送空 history + 会话列表，让用户主动从侧边栏选择要恢复的会话。
   */
  private tryRestoreLatestSession(): void {
    this.post({ type: 'history', messages: [] });
    this.pushSessionList();
    // 不再自动设置 currentSession = latest，
    // 用户需要在侧边栏手动点击历史会话才能恢复内容。
  }

  private handleNewSession(): void {
    this.taskLoop?.abort();
    this.taskLoop = null;
    this.currentSession = undefined;
    this.costTracker.resetSession();
    this.skillDedup.clear(); // W9.11 · 新会话清除 ALREADY LOADED 记录
    this.cancelAllPendingAsk('new session');
    this.cancelAllPendingApprovals('new session');
    this.pendingDiffs.clear();
    this.restoredDiffKeys.clear(); // B5 · 新会话清空已恢复 diff 记录
    // 新会话清空 workspaceState 中的 todo 列表，避免 webview 重新加载时恢复旧 todo
    this.setTodosAndPush([]);
    this.post({ type: 'history', messages: [] });
    this.pushSessionList();
    this.pushCostSummary();
  }

  private async handleLoadSession(sessionId: string): Promise<void> {
    const s = this.sessionStore.getSession(sessionId);
    if (!s) return;
    this.taskLoop?.abort();
    this.taskLoop = null;
    this.currentSession = s;
    this.costTracker.resetSession();
    this.skillDedup.clear(); // W9.11 · 切换会话清除 ALREADY LOADED 记录
    this.cancelAllPendingAsk('session switched');
    this.cancelAllPendingApprovals('session switched');
    this.pendingDiffs.clear();
    this.restoredDiffKeys.clear(); // B5 · 切换会话清空已恢复 diff 记录
    this.post({
      type: 'history',
      sessionId: s.id,
      messages: s.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
        .map((m) => ({
          role: m.role,
          content:
            typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? m.content
                    .filter((p) => p.type === 'text')
                    .map((p) => (p.type === 'text' ? p.text : ''))
                    .join('\n')
                : '',
        })),
    });
    this.pushCostSummary();
    this.pushSessionList();
    // Phase 3 · 恢复会话时重新推送 diff 数据，让 ChangeSummary 和 inline decorations 重建
    void this.restoreDiffsForSession(s);

    // ── Phase 5 Phase D C2 · Plan 恢复 ──
    // 若 session 关联了 planId 且 plan 状态为 in_progress，自动加载并缓存
    if (s.planId) {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (wsRoot) {
        try {
          const { getPlan } = await import('../core/task/plan-file-manager.js');
          const plan = await getPlan(s.planId, wsRoot);
          if (plan && plan.meta.status === 'in_progress') {
            const xml = await formatApprovedPlanXml(s.planId, wsRoot);
            if (xml) {
              this.cachedPlanXml = xml;
              log.info({ planId: s.planId }, 'C2: plan restored from session, cachedPlanXml ready');
            }
          }
        } catch (e) {
          log.warn({ err: String(e), planId: s.planId }, 'C2: plan restore failed');
        }
      }
    }
  }

  private async handleDeleteSession(sessionId: string): Promise<void> {
    await this.sessionStore.deleteSession(sessionId);
    if (this.currentSession?.id === sessionId) {
      this.handleNewSession();
    } else {
      this.pushSessionList();
    }
  }

  /** 清空所有会话历史 */
  private handleClearHistory(): void {
    // 终止当前任务
    this.taskLoop?.abort();
    this.taskLoop = null;
    this.currentSession = undefined;
    this.costTracker.resetSession();
    this.skillDedup.clear();
    this.cancelAllPendingAsk('clear history');
    this.cancelAllPendingApprovals('clear history');
    this.pendingDiffs.clear();
    this.restoredDiffKeys.clear();
    this.setTodosAndPush([]);

    // 清空 session store
    this.sessionStore.clearAll();
    this.post({ type: 'history', messages: [] });
    this.pushSessionList();
    this.pushCostSummary();
    log.info('all sessions cleared by user');
  }

  /** 记忆管理 */
  private handleOpenMemory(): void {
    void vscode.commands.executeCommand('devSeeker.openMemory');
  }

  /** 导出当前会话 */
  private handleExportSession(): void {
    if (!this.currentSession) {
      void vscode.window.showInformationMessage('当前无活跃会话可导出。');
      return;
    }
    void vscode.commands.executeCommand('devSeeker.session.export');
  }

  /** 检查更新 */
  private handleCheckUpdates(): void {
    void vscode.commands.executeCommand('workbench.extensions.action.checkForUpdates');
  }

  /** 关于 */
  private handleAbout(): void {
    void vscode.window.showInformationMessage(
      `DevSeeker v${this.context.extension?.packageJSON?.version ?? '?'}\n` +
      '技术 leader 型 AI 编码助手 · 双模型智能路由 · 自主 Agent',
    );
  }

  // ─────────── 任务启动 ───────────

  /**
   * 把 text + images 组装为 Message['content']（W7c / B-P2-6）。
   * - 无图：返回 string（保持与历史 session 兼容）
   * - 有图：先过 `clampImages` 两阶段降维（字节判定 + 可选 sharp 降维），
   *         然后返回 ContentPart[]（text + image_url...），供 router needsVision 路由
   *
   * 大图而 sharp 未安装时抛 `ImageOversizedError`，由上层 startTask 捕获
   * 并转为 task_end 错误事件。
   */
  private async buildUserContent(
    text: string,
    images?: readonly string[],
  ): Promise<Message['content']> {
    if (!images || images.length === 0) return text;
    const { ok, failed } = await clampImages(images);
    if (failed.length > 0) {
      // 聚合多张大图的错误分别报告，避免重复验证
      const detail = failed.map((e) => e.message).join('\n');
      throw new Error(detail);
    }
    const parts: NonNullable<Message['content']> = [];
    if (text && text.length > 0) parts.push({ type: 'text', text });
    for (const url of ok) {
      parts.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
    }
    return parts;
  }

  private async startTask(userInput: string, images?: readonly string[]): Promise<void> {
    const registry = getProviderRegistry();
    if (registry.list().length === 0) {
      this.post({
        type: 'task_event',
        event: {
          type: 'task_end',
          taskId: 'nil',
          reason: 'error',
          errorCode: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY,
          errorMessage:
            '未配置任何 Provider API Key。请在 VSCode 设置中搜索 "devSeeker" 并填入任一 Provider 的 apiKey。',
        },
      });
      return;
    }

    // 防重复触发
    if (this.taskLoop) {
      log.warn('Previous task still active, aborting first');
      this.taskLoop.abort();
    }

    // 清除暂停上下文（用户发了新消息而非点继续）
    if (this.pausedContext) {
      this.pausedContext = null;
      DualMindChatPanel.editorChangeBar?.onTaskEnd();
    }

    // W-UI2 · Bug fix：提前 ensure session，确保 tool_exec_start 时 currentSession 已存在
    // 以前 currentSession 在 persistCurrentSession（turn 结束后）才赋值，
    // 导致第一轮 tool_exec_start 时 hasSession=false，checkpoint 不创建，
    // checkpointId 拿不到，行内 ↶ revert 按钮无法显示。
    if (!this.currentSession) {
      const now = Date.now();
      this.currentSession = {
        id: newSessionId(),
        createdAt: now,
        updatedAt: now,
        title: userInput.slice(0, 40) || '新会话',
        messages: [],
        sessionCost: [],
      };
      log.info({ sessionId: this.currentSession.id }, '[W-UI2] pre-create session for checkpoint');
    }

    // Router 选 Provider —— 基于历史 + 本轮输入做决策
    // W7c · 有图时 content 为 ContentPart[]，router.needsVision 会据此路由到 vision 模型
    // B-P2-6 · buildUserContent 现为 async（内部 clampImages 降维），本轮只跳一次
    const priorMessages: Message[] = this.currentSession?.messages ?? [];
    let draftUserContent: Message['content'];
    try {
      draftUserContent = await this.buildUserContent(userInput, images);
    } catch (e) {
      this.post({
        type: 'task_event',
        event: {
          type: 'task_end',
          taskId: 'nil',
          reason: 'error',
          errorCode: ErrorCodes.CONTEXT_ATTACHMENT_INVALID_TYPE,
          errorMessage: e instanceof Error ? e.message : String(e),
        },
      });
      return;
    }
    const draftMessages: Message[] = [...priorMessages, { role: 'user', content: draftUserContent }];
    const hasImages = hasVisionContent(draftMessages);
    const preferred = this.getPreferredProviderId() ?? undefined;
    // 始终走 llm track，图片由 Vision SubAgent 处理
    const track = 'llm';
    
    // 获取默认 provider
    let defaultProvider: IProvider | undefined;
    if (preferred) {
      defaultProvider = registry.get(preferred);
    } else {
      defaultProvider = registry.getDefaultProvider(track);
    }

    // W15.5 · Auto-Thinking-Router：探测 userInput 复杂度，决定是否需 reasoning 模型。
    const probe = detectReasoningNeed(userInput);
    if (probe.needed) {
      log.info(
        { score: probe.score, signals: probe.signals },
        '[W15.5] reasoning probe: needsReasoning=true',
      );
    }

    let provider: IProvider;
    if (defaultProvider) {
      provider = defaultProvider;
    } else {
      // fallback 到 router 旧逻辑（兼容）
      const decision = this.router.pick({
        messages: draftMessages,
        hint: {
          ...(probe.needed ? { needsReasoning: true } : {}),
        },
      });
      if (!decision) {
        this.post({
          type: 'task_event',
          event: {
            type: 'task_end',
            taskId: 'nil',
            reason: 'error',
            errorCode: ErrorCodes.PROVIDER_MODEL_NOT_FOUND,
            errorMessage: '没有满足本次任务能力要求的 Provider（如需视觉能力请配置 VLLM）。',
          },
        });
        return;
      }
      provider = decision.provider;
    }

    this.activeProviderId = provider.id;
    const routeReason = hasImages ? 'llm-track-vision-subagent' : 'llm-track';
    log.info({ providerId: provider.id, reason: routeReason, hasImages }, 'provider selected');

    // W15.5 · Auto-Thinking-Router
    const modelOverride =
      probe.needed && provider.reasoningModel ? provider.reasoningModel : undefined;
    if (modelOverride) {
      log.info(
        { providerId: provider.id, modelOverride, signals: probe.signals },
        '[W15.5] switching to reasoning model',
      );
    }

    // W6b2：上一轮 create_plan 写的 plan 文档路径 → 本轮注入到 userInput 前
    const planPrefix = this.consumePlanDocPrefix();
    const effectiveUserInput = planPrefix ? planPrefix + userInput : userInput;

    // Vision by SubAgent（方案 A）：由 panel 层自动派发 Vision SubAgent 获取图片文本描述，
    // 将描述注入到 user message 后只传纯文本给 LLM，避免 deepseek 不支持 image_url。
    // 不再依赖 LLM 主动调 Agent 工具传图——LLM 主线程只处理文本。
    let finalUserContent: Message['content'];
    let effectiveImages: readonly string[] | undefined;
    let visionSummary: string | undefined;

    if (hasImages && images && images.length > 0) {
      // 1. 自动派发 Vision SubAgent
      const visionInvocation: SubagentInvocation = {
        subagent_type: 'Vision',
        description: '图片分析',
        prompt: `分析用户上传的图片。${userInput ? `用户提问：${userInput}` : '请详细描述图片内容。'}`,
        images,
        timeout: 60_000,
      };
      const visionDeps = this.buildSubagentRunnerDeps();
      if (!visionDeps.visionProvider) {
        log.warn({}, 'Vision SubAgent 未配置 VLLM Provider；使用占位符文本');
        visionSummary = '[图片分析失败：未配置视觉模型 Provider]';
      } else {
        try {
          this.post({
            type: 'task_event',
            event: { type: 'text_delta', taskId: 'vision-preprocess', text: '🧠 正在分析图片...\n\n' },
          });
          const visionResult: SubagentResult = await runSubagent(visionDeps, {
            invocation: visionInvocation,
          });
          visionSummary = visionResult.summary.trim();
          log.info({ summaryLen: visionSummary?.length }, 'Vision SubAgent completed');
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.warn({ err: msg }, 'Vision SubAgent failed, using fallback text');
          visionSummary = `[图片分析失败：${msg}]`;
        }
      }

      // 2. 拼接最终 user content：用户文本 + VLM 描述
      const textParts: string[] = [];
      if (userInput && userInput.length > 0) textParts.push(userInput);
      textParts.push(`\n<vision_result>\n${visionSummary ?? '[图片分析未返回结果]'}\n</vision_result>`);
      finalUserContent = textParts.join('\n\n');
      effectiveImages = undefined;
    } else {
      finalUserContent = stripImagesFromContent(draftUserContent);
      effectiveImages = images;
    }

    // ── Phase 5 Phase D C3 · 自动 Plan 决策树 ──
    // 只在非 Plan 模式下触发，避免递归
    if (this.modeManager.getCurrent() !== 'plan') {
      const planDecision = doesTaskNeedPlanning(userInput);
      if (planDecision === 'auto_plan') {
        log.info({ decision: planDecision, userInput: userInput.slice(0, 80) }, 'auto_plan triggered by decision tree');
        this.modeManager.setMode('plan', 'auto_plan');
        this.pushModeStatus('auto_plan');
      } else if (planDecision === 'suggest_plan') {
        // suggest_plan 暂不弹出 UI 提示，未来可以加浮动按钮
        log.info({ decision: planDecision, userInput: userInput.slice(0, 80) }, 'suggest_plan detected');
      }
    }

    // 传给 runWithProvider 的是剥离了 image_url 的 priorMessages 和纯文本 content
    const cleanPriorMessages: Message[] = hasImages ? stripImagesFromMessages(priorMessages) : priorMessages;
    await this.runWithProvider(provider, effectiveUserInput, cleanPriorMessages, routeReason, effectiveImages, finalUserContent, modelOverride);
  }

  private async runWithProvider(
    provider: IProvider,
    userInput: string,
    priorMessages: Message[],
    routeReason: string,
    images?: readonly string[],
    /** B-P2-6 · 预构造好的 user content（含 clampImages 降维后的 DataURL），避免重复跳维 */
    preBuiltContent?: Message['content'],
    /** W15.5 · 若非 undefined，TaskLoop 生命周期内所有轮次强制走该模型 id（reasoner） */
    modelOverride?: string,
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // W13.3-C · 历史图持续注入：
    // 轮证据标记
    this.debugModeEvidence = false;
    //   本 turn 含图 或 priorMessages 含图 → 注入 vlm_policy
    //   一旦会话进入"含图轨道"，整个会话后续所有轮都保留 VLM OCR 规约，避免：
    //     1) 用户先贴图再追问文本时模型失去识图规约导致前后策略不一致
    //     2) system prompt 结构频繁变化击穿 prompt-cache
    const hasVision = shouldKeepVisionPolicy(images, priorMessages);
    // W15.4c · 消费 inline edit 标记（一次性）
    const isInlineEdit = this.consumePendingInlineEdit();
    // V2 M3.14.6 · 用 provider id（如 "deepseek-v4"）+ modelOverride 确定 variant
    // provider.id 包含 "deepseek" 前缀 → 匹配 deepseek variant
    const modelId = modelOverride || provider.id;
    const systemPrompt = await this.buildSystemPrompt({
      hasVision,
      // v1.8.0: 传入当前轮 user 文本用于记忆语义匹配
      userQuery: userInput,
      modelId,
    });
    // B-P1-10/B-P1-11 · pending 片段属于"寄出一次后清空"语义：
    // 已注入 System Prompt，立即释放避免次轮縮放。
    this.pendingSelectedCodes = [];
    this.pendingGitContext = undefined;
    
    // W15.4c · Inline Edit 约束：限制工具 + 追加 system constraint
    const INLINE_EDIT_ALLOWED_TOOLS = new Set(['search_replace', 'create_file', 'read_file']);
    const INLINE_EDIT_CONSTRAINT = [
      '[Inline Edit Mode]',
      'This is an inline edit request. You MUST follow these rules:',
      '1. Only use search_replace or create_file tools to apply the edit.',
      '2. Do NOT use bash, search_codebase, or any other tools — edit the code directly.',
      '3. Apply the smallest possible change that satisfies the user request.',
      '4. Do NOT add comments explaining your change unless explicitly asked.',
      '5. After applying the edit, briefly describe what you changed (1-2 sentences).',
    ].join('\n');
    
    const effectiveSystemPrompt = isInlineEdit
      ? systemPrompt + '\n\n' + INLINE_EDIT_CONSTRAINT
      : systemPrompt;
    const hookManager = await this.getHookManager();
    const coordinator = this.getCheckpointCoordinator();
    coordinator?.beginTurn();

    // rc.4 · Bug-C：从 VS Code Settings 读取最大轮次（默认 150）
    // 用户可在 File → Preferences → Settings → DevSeeker → Max Turns 覆盖。
    const cfg = vscode.workspace.getConfiguration('devSeeker');
    const maxTurns = cfg.get<number>('maxTurns', 150);

    // 审计日志 sink（v1.8.0）
    const auditSink: import('../core/tools/approval-audit.js').ApprovalAuditSink | undefined =
      workspaceRoot ? new FileApprovalAuditSink(workspaceRoot) : undefined;

    // 加载 approval-policy.yaml（v1.8.0）
    const loadPolicy = async (): Promise<{
      overrides: import('../core/tools/approval-policy-loader.js').ToolOverride[];
      policyTable?: Partial<import('../core/tools/approval-policy.js').ApprovalPolicyTable>;
    }> => {
      try {
        return await loadApprovalPolicy(workspaceRoot);
      } catch {
        return { overrides: [], policyTable: {} };
      }
    };
    // 同步加载策略（异步不阻塞 ToolRunner 构造，decideApproval 在 run 时才执行）
    const { overrides, policyTable } = await loadPolicy();

    const loop = new TaskLoop({
      provider,
      toolRegistry: this.toolRegistry,
      systemPrompt: effectiveSystemPrompt,
      workspaceRoot,
      maxTurns,
      initialMessages: priorMessages.length > 0 ? priorMessages : undefined,
      ...(hookManager ? { hookManager } : {}),
      approvalGate: this.approvalGate,
      auditSink,
      approvalOverrides: overrides.length > 0 ? overrides : undefined,
      approvalPolicyTable:
        policyTable && Object.keys(policyTable).length > 0 ? policyTable : undefined,
      // W15.4c · Inline Edit 时限制可用工具；否则走 mode 默认过滤
      toolFilter: isInlineEdit
        ? (tool) => INLINE_EDIT_ALLOWED_TOOLS.has(tool.name)
        : (tool) => isToolAllowedInMode(tool, this.modeManager.getCurrent()),
      // W8 · Context Management：根据当前 provider 的 contextWindow 动态压缩
      contextManager: new ContextManager({ contextWindow: provider.contextWindow }),
      // S2 · DebugModeGate
      debugModeGate: (toolName: string) => {
        const mode = this.modeManager.getCurrent();
        if (mode !== 'debug') return { verdict: 'allow' };
        if (isEditTool(toolName) && !this.debugModeEvidence) {
          return { verdict: 'block', message: getBlockedMessage(toolName) };
        }
        return { verdict: 'allow' };
      },
      // W15.5 · Auto-Thinking-Router：reasoning 模式下透传 deepseek-reasoner 等 id
      ...(modelOverride ? { modelOverride } : {}),
      onEvent: (event) => {
        const t0 = performance.now();
        try {
          this.post({ type: 'task_event', event });
          // W12.3 · PerfProbe 接入（测量首 token / 总时长 / cache 命中率）
          if (event.type === 'task_start') {
            perfProbe.markTaskSend(event.taskId);
          } else if (event.type === 'text_delta' || event.type === 'reasoning_delta') {
            perfProbe.markFirstDelta(event.taskId);
          } else if (event.type === 'usage') {
            perfProbe.recordUsage(event.taskId, {
              promptTokens: event.promptTokens,
              ...(event.cachedTokens !== undefined ? { cachedTokens: event.cachedTokens } : {}),
            });
          } else if (event.type === 'task_end') {
            perfProbe.markTaskEnd(event.taskId);
          }
          // S2 · DebugModeGate：记录取证工具调用
          if (event.type === 'tool_exec_start') {
            const EVIDENCE_TOOLS = new Set(['read_file', 'trace_error', 'goto_definition', 'find_references', 'call_hierarchy', 'lsp', 'bash', 'get_terminal_output', 'get_problems']);
            if (EVIDENCE_TOOLS.has(event.name)) {
              this.debugModeEvidence = true;
            }
          }
          // Checkpoint：写前快照
          if (coordinator && event.type === 'tool_exec_start' && TRACKED_WRITE_TOOLS.has(event.name)) {
            // [dbg T-UI2] 诊断日志：记录 tool_exec_start 命中 TRACKED 白名单
            log.info(
              { tool: event.name, toolCallId: event.toolCallId, args: event.args, hasWsRoot: !!workspaceRoot, hasSession: !!this.currentSession },
              '[dbg T-UI2] tool_exec_start TRACKED',
            );
            // turn 级聚合（保留 W5b2b 原有逻辑，用于任务结束时兜底快照）
            coordinator.onToolExec(event.name, event.args);
            // W7b2 · step 粒度：每个写类工具独立 checkpoint，便于 per-step revert
            // 注：checkpoint 需要 session，但 diff 快照只需要 workspaceRoot，两者解耦
            let cpPromise: Promise<string | undefined> = Promise.resolve(undefined);
            if (this.currentSession) {
              const snapshot = loop.getHistorySnapshot().filter((m) => m.role !== 'system');
              cpPromise = coordinator
                .createStepCheckpoint({
                  sessionId: this.currentSession.id,
                  messages: snapshot,
                  toolName: event.name,
                  toolArgs: event.args,
                })
                .then((cp) => {
                  if (cp) void vscode.commands.executeCommand('devSeeker.checkpoints.refresh');
                  return cp?.id;
                });
            }
            // W7b4b · 同步捕获 before 快照，用于 tool_exec_end 时生成 diff
            // Bug-fix：pendingDiffs 不依赖 currentSession，只要 workspaceRoot 存在就记录
            if (workspaceRoot) {
              const target = resolveWriteTarget(event.args, workspaceRoot);
              // [dbg T-UI2] 诊断日志：记录 resolveWriteTarget 是否成功
              log.info(
                { toolCallId: event.toolCallId, target, rawArgs: event.args },
                '[dbg T-UI2] resolveWriteTarget result',
              );
              if (target) {
                const before = readBeforeSync(target.absPath);
                this.pendingDiffs.set(event.toolCallId, {
                  relPath: target.relPath,
                  absPath: target.absPath,
                  before,
                  checkpointPromise: cpPromise,
                });
              }
            }
          }
          // W7b4b · 工具执行完成 → 生成 diff 推送给 UI
          if (event.type === 'tool_exec_end' && this.pendingDiffs.has(event.toolCallId)) {
            const pending = this.pendingDiffs.get(event.toolCallId)!;
            this.pendingDiffs.delete(event.toolCallId);
            // [dbg T-UI2] 诊断日志：tool_exec_end 命中 pendingDiff
            log.info(
              { toolCallId: event.toolCallId, ok: event.ok, relPath: pending.relPath },
              '[dbg T-UI2] tool_exec_end has pendingDiff',
            );
            if (event.ok) {
              void this.emitToolDiff(event.toolCallId, event.name, pending);
            }
          } else if (event.type === 'tool_exec_end' && TRACKED_WRITE_TOOLS.has(event.name)) {
            // [dbg T-UI2] 写类工具结束但没找到 pendingDiff —— 说明 start 阶段没 set
            log.warn(
              { toolCallId: event.toolCallId, name: event.name, ok: event.ok },
              '[dbg T-UI2] tool_exec_end MISSING pendingDiff',
            );
          }
          // 成本累计
          if (event.type === 'usage' && this.activeProviderId) {
            const tracked = this.costTracker.record(
              this.activeProviderId,
              {
                promptTokens: event.promptTokens,
                completionTokens: event.completionTokens,
                cachedTokens: event.cachedTokens,
              },
              provider.pricing,
              {
                ...(this.currentSession?.id ? { sessionId: this.currentSession.id } : {}),
                operation: 'chat',
              },
            );
            void tracked; // noop; summary 会推送
            this.pushCostSummary();
          }
        } catch (e) {
          log.warn({ err: String(e) }, 'post task_event failed');
        } finally {
          const dt = performance.now() - t0;
          if (dt > 50) {
            log.warn({ dt, eventType: event.type }, 'Panel onEvent slow');
          }
        }
      },
    });
    this.taskLoop = loop;
    log.info({ providerId: provider.id, reason: routeReason }, 'TaskLoop started');

    let fellBack = false;
    /** 本轮失败的 terminal reason（finally 中用于弹窗通知） */
    let terminalReason: FailoverReason | undefined;
    try {
      // B-P2-6 · preBuiltContent 存在时（Vision SubAgent 拼接后的文本）替代 userInput，
      // 确保 LLM 收到的是含 <vision_result> 的完整内容而非原始用户文本。
      const sendInput = typeof preBuiltContent === 'string' ? preBuiltContent : userInput;
      log.info({ providerId: provider.id, userInputLen: sendInput.length }, 'loop.send() starting');
      const result = await loop.send(sendInput, images);
      log.info({ providerId: provider.id, ok: result.ok, errorCode: result.errorCode }, 'loop.send() completed');

      // M4 · 后台预取：send() 结束后根据用户输入预取下一轮可能的记忆
      if (this.prefetchEngine && userInput) {
        this.prefetchEngine.queuePrefetch(userInput);
      }
      // W15.7 · 任务正常返回但以 error 终止 → 检查是否可 fallback
      if (result.ok) {
        this.router.recordSuccess(provider.id);
        // P1-1: 成功请求后重置 Key 轮换状态
        getProviderRegistry().resetKeyRotation(provider.id);
      } else {
        // 错误终止：记录失败，尝试 fallback
        this.router.recordFailure(provider.id);
        log.warn(
          { providerId: provider.id, errorCode: result.errorCode, errorMessage: result.errorMessage },
          'TaskLoop ended with error; checking fallback',
        );

        // P0-5: 使用 FailoverReason 分类替代 hardcoded retryableCodes
        const reason = classifyErrorCode(result.errorCode ?? '');
        terminalReason = reason;
        const strategy = FAILOVER_STRATEGY[reason];

        if (strategy === 'next_level') {
          // P1-1: 优先在同级内轮换 API Key，全部 Key 耗尽才降级
          const registry = getProviderRegistry();
          if (registry.hasMoreKeys(provider.id)) {
            const rotated = registry.rotateApiKey(provider.id);
            if (rotated) {
              fellBack = true;
              log.info(
                { providerId: provider.id, keyIndex: registry.getCurrentKeyIndex(provider.id), errorCode: result.errorCode },
                'retrying with rotated API Key (same level)',
              );
              // 用同一个 Provider（但 Key 已换）重试
              if (this.taskLoop === loop) this.taskLoop = null;
              this.activeProviderId = provider.id;
              await this.runWithProvider(
                provider,
                userInput,
                priorMessages,
                `key-rotate-${provider.id}`,
                images,
                undefined,
                modelOverride,
              );
              return;
            }
          }

          // Key 轮换耗尽 → 3 级降级链：从 registry 获取下一个 Level 的 Provider
          // 降级目标必须支持 tool-use（当前任务使用了工具）
          const fallbackProvider = registry.getNextLevel(provider.id, ['tool-use']);

          if (fallbackProvider) {
            fellBack = true;
            log.info(
              { from: provider.id, to: fallbackProvider.id, errorCode: result.errorCode },
              'falling back to next level provider',
            );
            if (this.taskLoop === loop) this.taskLoop = null;
            this.activeProviderId = fallbackProvider.id;
            const fallbackOverride =
              modelOverride && fallbackProvider.reasoningModel
                ? fallbackProvider.reasoningModel
                : undefined;
            await this.runWithProvider(
              fallbackProvider,
              userInput,
              priorMessages,
              `fallback-from-${provider.id}`,
              images,
              undefined,
              fallbackOverride,
            );
            return;
          }
        }

        // P2: same_level_retry 策略 — stream_broken / context_overflow
        if (strategy === 'same_level_retry') {
          const registry = getProviderRegistry();

          if (reason === 'stream_broken') {
            // C9: Provider 侧已重试 5 次 + 非流式兜底均失败 → 降级到下一级
            // 同 level 重试已在 openai-compatible.ts 内完成，此处走跨 level 降级
            const fallbackProvider = registry.getNextLevel(provider.id, ['tool-use']);
            if (fallbackProvider) {
              fellBack = true;
              log.info(
                { from: provider.id, to: fallbackProvider.id, errorCode: result.errorCode },
                'stream_broken: all same-level retries exhausted, falling back to next level',
              );
              if (this.taskLoop === loop) this.taskLoop = null;
              this.activeProviderId = fallbackProvider.id;
              const fallbackOverride =
                modelOverride && fallbackProvider.reasoningModel
                  ? fallbackProvider.reasoningModel
                  : undefined;
              await this.runWithProvider(
                fallbackProvider,
                userInput,
                priorMessages,
                `stream-broken-fallback-${provider.id}`,
                images,
                undefined,
                fallbackOverride,
              );
              return;
            }
          }

          if (reason === 'context_overflow') {
            // C7: 先压缩历史，同级重试；压缩无效时降级到上下文窗口 >= 当前的模型
            const ctxManager = new ContextManager({ contextWindow: provider.contextWindow });
            const compressed = ctxManager.compress(priorMessages, 'heavy');
            if (compressed.savingsPercent > 0) {
              fellBack = true;
              log.info(
                { providerId: provider.id, savingsPercent: compressed.savingsPercent, originalTokens: compressed.originalTokens, compressedTokens: compressed.compressedTokens },
                'context_overflow: compressing history and retrying same level',
              );
              if (this.taskLoop === loop) this.taskLoop = null;
              await this.runWithProvider(
                provider,
                userInput,
                compressed.messages,
                `context-overflow-retry-${provider.id}`,
                images,
                undefined,
                modelOverride,
              );
              return;
            }
            // 压缩后仍超限 → 降级到上下文窗口更大的模型（C7: 不降级到更小窗口）
            const fallbackProvider = registry.getNextLevelWithLargerContext(provider.id, ['tool-use']);
            if (fallbackProvider) {
              fellBack = true;
              log.info(
                { from: provider.id, to: fallbackProvider.id, fromContextWindow: provider.contextWindow, toContextWindow: fallbackProvider.contextWindow },
                'context_overflow: compression insufficient, falling back to provider with larger context',
              );
              if (this.taskLoop === loop) this.taskLoop = null;
              this.activeProviderId = fallbackProvider.id;
              const fallbackOverride =
                modelOverride && fallbackProvider.reasoningModel
                  ? fallbackProvider.reasoningModel
                  : undefined;
              await this.runWithProvider(
                fallbackProvider,
                userInput,
                priorMessages,
                `context-overflow-fallback-${provider.id}`,
                images,
                undefined,
                fallbackOverride,
              );
              return;
            }
          }
        }
      }
    } catch (e) {
      const err = e instanceof AgentError ? e : toAgentError(e);
      log.error(
        { code: err.code, msg: err.message, providerId: provider.id },
        'send failed; checking fallback',
      );

      // 记录 terminal reason（catch 后续没有 fallback 时在 finally 中弹通知）
      if (err.code) {
        terminalReason = classifyErrorCode(err.code);
      }

      // 可重试错误 → P1-1 先轮换 Key，再 3 级降级链 fallback
      const canFallback = err.retryable || err.code === ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY;
      const registry = getProviderRegistry();

      // P1-1: 先尝试同 Level 内 Key 轮换
      if (canFallback && registry.hasMoreKeys(provider.id)) {
        const rotated = registry.rotateApiKey(provider.id);
        if (rotated) {
          fellBack = true;
          log.info(
            { providerId: provider.id, keyIndex: registry.getCurrentKeyIndex(provider.id) },
            'retrying with rotated API Key (catch, same level)',
          );
          if (this.taskLoop === loop) this.taskLoop = null;
          this.activeProviderId = provider.id;
          await this.runWithProvider(
            provider,
            userInput,
            priorMessages,
            `key-rotate-catch-${provider.id}`,
            images,
            undefined,
            modelOverride,
          );
          return;
        }
      }

      const fallbackProvider = canFallback
        ? registry.getNextLevel(provider.id, ['tool-use'])
        : undefined;

      if (fallbackProvider) {
        fellBack = true;
        log.info(
          { from: provider.id, to: fallbackProvider.id },
          'falling back to next level provider (catch)',
        );
        if (this.taskLoop === loop) this.taskLoop = null;
        this.activeProviderId = fallbackProvider.id;
        const fallbackOverride =
          modelOverride && fallbackProvider.reasoningModel
            ? fallbackProvider.reasoningModel
            : undefined;
        await this.runWithProvider(
          fallbackProvider,
          userInput,
          priorMessages,
          `fallback-from-${provider.id}`,
          images,
          undefined,
          fallbackOverride,
        );
        return;
      }

      // P2: catch 路径的 same_level_retry 处理
      const catchReason = classifyErrorCode(err.code ?? '');
      const catchStrategy = FAILOVER_STRATEGY[catchReason];

      if (catchStrategy === 'same_level_retry') {
        if (catchReason === 'stream_broken') {
          const streamFallback = registry.getNextLevel(provider.id, ['tool-use']);
          if (streamFallback) {
            fellBack = true;
            log.info(
              { from: provider.id, to: streamFallback.id, errorCode: err.code },
              'stream_broken (catch): falling back to next level',
            );
            if (this.taskLoop === loop) this.taskLoop = null;
            this.activeProviderId = streamFallback.id;
            const fallbackOverride =
              modelOverride && streamFallback.reasoningModel
                ? streamFallback.reasoningModel
                : undefined;
            await this.runWithProvider(
              streamFallback,
              userInput,
              priorMessages,
              `stream-broken-catch-${provider.id}`,
              images,
              undefined,
              fallbackOverride,
            );
            return;
          }
        }

        if (catchReason === 'context_overflow') {
          const ctxManager = new ContextManager({ contextWindow: provider.contextWindow });
          const compressed = ctxManager.compress(priorMessages, 'heavy');
          if (compressed.savingsPercent > 0) {
            fellBack = true;
            log.info(
              { providerId: provider.id, savingsPercent: compressed.savingsPercent },
              'context_overflow (catch): compressing history and retrying same level',
            );
            if (this.taskLoop === loop) this.taskLoop = null;
            await this.runWithProvider(
              provider,
              userInput,
              compressed.messages,
              `context-overflow-catch-${provider.id}`,
              images,
              undefined,
              modelOverride,
            );
            return;
          }
          const ctxFallback = registry.getNextLevelWithLargerContext(provider.id, ['tool-use']);
          if (ctxFallback) {
            fellBack = true;
            log.info(
              { from: provider.id, to: ctxFallback.id },
              'context_overflow (catch): falling back to provider with larger context',
            );
            if (this.taskLoop === loop) this.taskLoop = null;
            this.activeProviderId = ctxFallback.id;
            const fallbackOverride =
              modelOverride && ctxFallback.reasoningModel
                ? ctxFallback.reasoningModel
                : undefined;
            await this.runWithProvider(
              ctxFallback,
              userInput,
              priorMessages,
              `context-overflow-catch-fallback-${provider.id}`,
              images,
              undefined,
              fallbackOverride,
            );
            return;
          }
        }
      }

      this.post({
        type: 'task_event',
        event: {
          type: 'task_end',
          taskId: loop.taskId,
          reason: 'error',
          errorCode: err.code,
          errorMessage: err.toUserMessage(),
        },
      });
    } finally {
      if (!fellBack) {
        // ── User-visible notification for terminal errors ──
        if (terminalReason === 'billing') {
          void vscode.window.showWarningMessage(
            `DevSeeker: 当前 API（${provider.id}）余额不足（Insufficient Balance），任务已终止。` +
            `请充值或修改 devSeeker.models.llm.level1.apiKey 后重试。`,
          );
        } else if (terminalReason === 'context_overflow') {
          void vscode.window.showWarningMessage(
            `DevSeeker: 消息历史过长，已被截断拦截以防止上下文溢出。` +
            `请点击清除对话或新建会话后重试。`,
          );
        }

        if (this.taskLoop === loop) this.taskLoop = null;
        // 通知 EditorChangeBar 任务结束（重置暂停状态）
        DualMindChatPanel.editorChangeBar?.onTaskEnd();
        log.info('runWithProvider finally: persisting session');
        await this.persistCurrentSession(loop);
        log.info('runWithProvider finally: session persisted');
        // Checkpoint：任务结束后落盘（即使失败也记，便于回滚半成品）
        if (coordinator && this.currentSession) {
          const snapshot = loop.getHistorySnapshot().filter((m) => m.role !== 'system');
          await coordinator.finalizeTurn({
            sessionId: this.currentSession.id,
            messages: snapshot,
            label: userInput.slice(0, 40),
          });
          log.info('runWithProvider finally: checkpoint finalized');
          // 通知 Checkpoints 侧边栏刷新（W5b3）
          void vscode.commands.executeCommand('devSeeker.checkpoints.refresh');
        }
        log.info('runWithProvider finally: done');
      }
    }
  }

  private async persistCurrentSession(loop: TaskLoop): Promise<void> {
    try {
      const snapshot = loop.getHistorySnapshot();
      const now = Date.now();
      const existing = this.currentSession;
      // C2 · 从 modeManager 获取 plan 文件路径，提取 planId
      const planDocPath = this.modeManager.snapshot().planDoc;
      let planId: string | undefined;
      if (planDocPath) {
        const basename = planDocPath.split(/[/\\]/).pop() ?? '';
        planId = basename.endsWith('.md') ? basename.slice(0, -3) : basename;
      }

      const nextSession: StoredSession = {
        id: existing?.id ?? newSessionId(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        title: existing?.title ?? extractTitleFromMessages(snapshot),
        messages: snapshot.filter((m) => m.role !== 'system'),
        sessionCost: this.costTracker.summary().byProvider,
        ...(planId ? { planId } : {}),
      };
      this.currentSession = nextSession;
      await this.sessionStore.saveSession(nextSession);
      await this.sessionStore.saveTotalCost(this.costTracker.serializeTotal());
      this.pushSessionList();
    } catch (e) {
      log.warn({ err: String(e) }, 'persistCurrentSession failed; swallow');
    }
  }

  // ─────────── CodebaseIndex 管理 ───────────

  /** 懒加载 / 初始化 LSP 桥接器（未打开工作区则返回 undefined） */
  private getLspBridge(): LspBridge | undefined {
    if (this.lspBridge) return this.lspBridge;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return undefined;
    this.lspBridge = new VSCodeLspBridge({ workspaceRoot });
    return this.lspBridge;
  }

  /** 懒加载 / 初始化 Problems 桥接器（W7e1；未打开工作区则返回 undefined） */
  private getProblemsBridge(): ProblemsBridge | undefined {
    if (this.problemsBridge) return this.problemsBridge;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return undefined;
    this.problemsBridge = new VSCodeProblemsBridge({ workspaceRoot });
    return this.problemsBridge;
  }

  // ─── W7e4 · Todo 管理 ───

  /** 读取当前 todo 列表（从 workspaceState 反序列化） */
  private getTodos(): TodoItem[] {
    return this.context.workspaceState.get<TodoItem[]>(TODO_LIST_KEY, []);
  }

  /** 写入 todo 列表 + 持久化 + 推送 webview */
  private setTodosAndPush(todos: TodoItem[]): void {
    void this.context.workspaceState.update(TODO_LIST_KEY, todos);
    this.pushTodoList(todos);
  }

  /** 推送 todo 列表到 webview */
  private pushTodoList(todos: TodoItem[]): void {
    const payload: TodoListPayload = { todos };
    this.post({ type: 'todo_list', payload });
  }

  /** 懒加载 / 初始化 MemoryManager（Phase 5 Phase A Step 3）+ PrefetchEngine（M4） */
  private getMemoryManager(): MemoryManager | undefined {
    if (this.memoryManager) return this.memoryManager;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const builtin = new BuiltinMemoryProvider({
      workspaceRoot,
      embedder: this.getCachedEmbedder(),
    });
    this.memoryManager = new MemoryManager({ builtin });
    // M4 · 后台预取引擎：下次 send 结束后 queuePrefetch，下次 buildSystemPrompt 时 consumeHit
    this.prefetchEngine = new PrefetchEngine(() => {
      return this.memoryManager!.list().catch(() => []);
    }, this.getCachedEmbedder());
    return this.memoryManager;
  }

  /**
   * 返回已缓存的 embedder（可能为 undefined）。
   * 不同于 buildEmbedderAsync（主动构造），只返回缓存实例。
   */
  private getCachedEmbedder(): Embedder | undefined {
    return this._embedderCache;
  }

  /** 懒加载 / 初始化 RuleLoader（支持 global + workspace 两源；任一存在即创建） */
  private getRuleLoader(): RuleLoader | undefined {
    if (this.ruleLoader) return this.ruleLoader;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // 即使没打开工作区，也允许加载 global 规则（~/.devseeker/rules/）
    this.ruleLoader = new RuleLoader({ workspaceRoot });
    return this.ruleLoader;
  }

  /** 懒加载 / 初始化 SkillLoader */
  private getSkillLoader(): SkillLoader | undefined {
    if (this.skillLoader) return this.skillLoader;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // W8.7：即使未打开工作区也注入内置种子 skill；有工作区时同名的 workspace skill 会覆盖 builtin。
    this.skillLoader = new SkillLoader({ workspaceRoot, builtinSkills: BUILTIN_SKILLS });
    return this.skillLoader;
  }

  /** W14.4 · 懒加载 / 初始化 AgentLoader（自定义 agents） */
  private getAgentLoader(): AgentLoader | undefined {
    if (this.agentLoader) return this.agentLoader;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return undefined;
    this.agentLoader = new AgentLoader({ workspaceRoot });
    return this.agentLoader;
  }

  /**
   * W14.4 · 合成 SubagentRegistry（内置 + 用户自定义）。
   * 异步：首次调用会 load `.devseeker/agents/`；AgentTool 在 execute 中 await。
   * 无工作区 / 加载失败 → 返回 undefined，AgentTool 自行降级到内置 registry。
   */
  private async getSubagentRegistry(): Promise<ReturnType<typeof createSubagentRegistry> | undefined> {
    const loader = this.getAgentLoader();
    if (!loader) return undefined;
    try {
      await loader.load();
    } catch (e) {
      log.warn({ err: String(e) }, 'AgentLoader.load failed');
    }
    return createSubagentRegistry(loader.list());
  }

  /**
   * 懒加载 / 初始化 HookManager；读取 `.devseeker/hooks.json`（若存在）。
   * 加载失败（配置非法）以 toast 报警但不中断任务。
   */
  private async getHookManager(): Promise<HookManager | undefined> {
    if (this.hookManager) return this.hookManager;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return undefined;
    const mgr = createDefaultManager({ workspaceRoot });
    try {
      const result = await loadHookConfig(workspaceRoot);
      if (result.error) {
        void vscode.window.showWarningMessage(
          `[DevSeeker] .devseeker/hooks.json 解析失败：${result.error}`,
        );
      } else if (result.config) {
        mgr.setConfig(result.config);
        log.info({ hooks: result.config.hooks.length }, 'hook config loaded');
      }
    } catch (e) {
      log.warn({ err: String(e) }, 'loadHookConfig failed');
    }
    this.hookManager = mgr;
    return mgr;
  }

  /**
   * W11.3 · 外部 listHooks 接口（供 `DevSeeker: Show Hooks` 命令使用）
   * 返回当前已加载的 hook spec 列表。若未初始化则触发一次加载。
   */
  async listLoadedHooks(): Promise<HookSpec[]> {
    const mgr = await this.getHookManager();
    if (!mgr) return [];
    return mgr.list();
  }

  /**
   * B-P3-6 · 导出指定会话（或当前会话）为 md / json 字符串。
   * 当 sessionId 省略时导出 currentSession；找不到时返回 undefined。
   * 实际写盘由 extension.ts 的 `devSeeker.session.export` 命令负责。
   */
  exportSessionContent(
    format: 'md' | 'json',
    sessionId?: string,
  ): { content: string; session: StoredSession } | undefined {
    const id = sessionId ?? this.currentSession?.id;
    if (!id) return undefined;
    const session = this.sessionStore.getSession(id);
    if (!session) return undefined;
    const content = this.sessionStore.exportSession(id, format);
    if (content === undefined) return undefined;
    return { content, session };
  }

  /** B-P3-6 · 列出全部会话摘要（供命令面板 pick 使用） */
  listSessionSummaries(): SessionSummary[] {
    return this.sessionStore.listSessions().map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length,
    }));
  }

  /**
   * B-P1-10 · 外部命令（如「右键 Ask」）追加一段选区片段到待注入队列，
   * 同时将同等片段作为草稿预填到 Composer（供用户可见确认）。
   * 次次请求的 buildSystemPrompt 会自动将队列注入 L3 的 `<selected_codes>` 块。
   */
  pushSelectedCode(
    input: { filePath: string; startLine: number; endLine: number; text: string },
    opts?: { switchToAsk?: boolean; prefillDraft?: boolean },
  ): void {
    this.pendingSelectedCodes.push({ ...input });
    if (opts?.switchToAsk) {
      this.handleSetModeFromUser('ask');
    }
    if (opts?.prefillDraft !== false) {
      const loc =
        input.startLine === input.endLine
          ? `${input.filePath}:${input.startLine}`
          : `${input.filePath}:${input.startLine}-${input.endLine}`;
      this.prefillInput(`请基于选区片段回答（${loc}）：\n\n`);
    }
    try {
      this.panel.reveal(undefined, true);
    } catch {
      /* panel already disposed */
    }
  }

  /** B-P1-10 · 清空待注入的 selected_codes（服务于"寄出后一次性"语义，供测试 / 手动重置） */
  clearPendingSelectedCodes(): void {
    this.pendingSelectedCodes = [];
  }
  
  /** W15.4c · 设置下次 send 时应用 Inline Edit 约束（一次性消费） */
  setPendingInlineEdit(value: boolean): void {
    this.pendingInlineEdit = value;
  }
  
  /** W15.4c · 消费 pendingInlineEdit 标记（读后清零） */
  private consumePendingInlineEdit(): boolean {
    const val = this.pendingInlineEdit;
    this.pendingInlineEdit = false;
    return val;
  }
  
  /** W15.4b · 获取或懒初始化 InlineEditHistory */
  private getInlineEditHistory(): InlineEditHistory {
    if (!this.inlineEditHistory) {
      this.inlineEditHistory = new InlineEditHistory(this.context.globalState);
    }
    return this.inlineEditHistory;
  }
  
  /** W15.4b · 记录一次 Inline Edit 操作到历史 */
  recordInlineEditHistory(filePath: string, startLine: number, endLine: number, snippet: string): void {
    const hist = this.getInlineEditHistory();
    void hist.record({
      filePath,
      startLine,
      endLine,
      snippetPreview: snippet.slice(0, 500),
    });
  }

  /** B-P1-11 · 设置下次 System Prompt 注入的 git 上下文块（已格式化的文本） */
  setPendingGitContext(block: string | undefined): void {
    this.pendingGitContext = block;
  }

  /**
   * W12.1 · Inline Edit 基线：从 extension 侧向 webview 推送一段草稿，
   * Composer 收到后会拼接到 textarea 末尾（已有内容就用空行隔开）。
   * 面板未打开时由调用方负责先 `createOrShow()` 再调用本函数。
   */
  prefillInput(text: string, opts?: { isInlineEdit?: boolean }): void {
    if (!text) return;
    this.prefillNonceSeq += 1;
    this.post({
      type: 'prefill_input',
      text,
      nonce: this.prefillNonceSeq,
      ...(opts?.isInlineEdit ? { isInlineEdit: true } : {}),
    });
    // 确保面板可见，带入焦点
    try {
      this.panel.reveal(undefined, true);
    } catch {
      // 面板已 dispose 的 fallback，忽略
    }
  }

  /**
   * 懒加载 / 初始化 CheckpointCoordinator。
   * 未打开工作区时返回 undefined（禁用 checkpoint 能力）。
   */
  private getCheckpointCoordinator(): CheckpointCoordinator | undefined {
    if (this.checkpointCoordinator) return this.checkpointCoordinator;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return undefined;
    const store = new CheckpointStore({ workspaceRoot });
    this.checkpointCoordinator = new CheckpointCoordinator({ store, workspaceRoot });
    return this.checkpointCoordinator;
  }

  /**
   * 通用审批门（DESIGN §M9.5.1 v1.8.0）。
   * 向 Webview 发送内联审批卡片，用户在聊天流中直接点击按钮决策。
   * 不设超时，用户不点击就一直等待。
   */
  private approvalGate: ToolApprovalGate = async ({ tool, args, ctx, reason, command, commandSafety, allowRemember }) => {
    // 会话内已记住 → 跳过审批
    const memoryKey = `approval:${tool.name}`;
    if (this.approvedExternalTools.has(memoryKey)) return { approved: true };

    // 参数预览（截断，避免卡片过长）
    let argsPreview = '';
    try {
      argsPreview = JSON.stringify(args);
    } catch {
      argsPreview = String(args);
    }
    if (argsPreview.length > 300) argsPreview = argsPreview.slice(0, 300) + '…';

    // 生成 requestId
    const requestId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 命令风险级别（影响 UI 默认按钮和风险图标）
    const riskLevel = commandSafety === 'safe' ? 'safe' : commandSafety === 'risky' ? 'risky' : undefined;

    // 构建 payload 并发送到 Webview（带 toolCallId 关联到已有的 ToolCard）
    const payload: ApprovalRequestPayload = {
      requestId,
      toolCallId: ctx.toolCallId,
      toolName: tool.name,
      safetyLevel: tool.safetyLevel ?? 'confirm',
      riskLevel,
      reason,
      command,
      argsPreview,
      allowRemember,
    };
    this.post({ type: 'approval_request', payload });

    // 等待用户在 Webview 中点击
    return new Promise<{ approved: boolean; remember?: boolean }>((resolve) => {
      this.approvalPending.set(requestId, {
        resolve,
        toolName: tool.name,
        command: command ?? undefined,
        cwd: (args as Record<string, unknown>)?.cwd as string | undefined,
      });
    });
  };

  /**
   * 用户终端（终端运行）管理已移至 VscodeTerminalManager.runCommandOnUserTerminal。
   * 删除 sendToUserTerminal 方法，所有终端执行统一走 BashTool → VscodeTerminalManager。
   *
   * 构造动态 System Prompt（W3.6 · DESIGN §M3.6 Cache Priority Ordering）：
   *
   * 采集数据 → 委托 `PromptBuilder.build()` 按四层稳定区拼接：
   *   L0 identity & protocol（永不变）
   *   L1 mode + skills（mode 切换 / skill 文件变动时变）
   *   L2 rules + model_decision + memory_overview（rule/memory 变动时变）
   *   L3 attachments（预留）
   *
   * 此层次让 Prompt Cache 在 mode 不变时基本命中 L0+L1；rule 变动仅破坏 L2+。
   */
  private async buildSystemPrompt(
    options: { hasVision?: boolean; userQuery?: string; modelId?: string } = {},
  ): Promise<string> {
    const loader = this.getRuleLoader();
    const skillLoader = this.getSkillLoader();
    const memManager = this.getMemoryManager();

    // ── 规则：load + select（activeFile / recentFiles 驱动 glob 命中） ──
    let allRules: Rule[] = [];
    let selectedRules: Rule[] = [];
    if (loader) {
      try {
        await loader.load();
        allRules = loader.list();
        if (allRules.length > 0) {
          const activeFile = vscode.window.activeTextEditor
            ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri, false)
            : undefined;
          const recentFiles = vscode.workspace.textDocuments
            .filter((d) => d.uri.scheme === 'file')
            .slice(0, 20)
            .map((d) => vscode.workspace.asRelativePath(d.uri, false));
          selectedRules = selectForPrompt(allRules, {
            ...(activeFile !== undefined ? { activeFile } : {}),
            recentFiles,
          });
        }
      } catch (e) {
        log.warn({ err: String(e) }, 'buildSystemPrompt(rules) failed; continue');
      }
    }

    // ── 技能 ──
    let skills: Skill[] = [];
    if (skillLoader) {
      try {
        await skillLoader.load();
        skills = skillLoader.list();
      } catch (e) {
        log.warn({ err: String(e) }, 'buildSystemPrompt(skills) failed; continue');
      }
    }

    // ── 记忆（Phase 5 Phase D M2 · 冻结快照） ──
    let memoryOverview: string | undefined;
    let taskContext: string | undefined;
    if (memManager) {
      try {
        // 冻结快照：session 启动时构建一次，后续轮次使用缓存
        if (!this.frozenMemorySnapshot) {
          const snapshot = await buildFrozenSnapshot(memManager);
          this.frozenMemorySnapshot = snapshot;
          memoryOverview = snapshot.systemPromptBlock;
          taskContext = renderTaskContextSection(snapshot.memories);
        } else {
          memoryOverview = this.frozenMemorySnapshot.systemPromptBlock;
          // 非首轮只保留冻结快照
        }
      } catch (e) {
        log.warn({ err: String(e) }, 'buildSystemPrompt(memory_overview) failed; continue');
        // 回退：全量注入
        try {
          const memories = await memManager.list();
          memoryOverview = `<memory_overview>\n${memories.map((m: MemoryRecord) => `- [${m.category}] ${m.title}: ${(m.content || '').slice(0, 200)}`).join('\n')}\n</memory_overview>`;
          taskContext = renderTaskContextSection(memories);
        } catch {}
      }
    }

    // B-P1-11 · 自动采集 git 上下文（branch / 最近 commits / staged stat / status），
    // pending 优先（外部命令明确设置时覆盖默认采集）。
    const workspaceRoot2 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let gitContext: string | undefined = this.pendingGitContext;
    if (gitContext === undefined && workspaceRoot2) {
      try {
        gitContext = await buildGitContextBlock({ cwd: workspaceRoot2 });
      } catch (e) {
        log.warn({ err: String(e) }, 'buildSystemPrompt(gitContext) failed; continue');
      }
    }

    // B-P1-13 · M10.1 框架自动注入 4 块（current_open_file / open_tabs /
    //   workspace_tree / git_status / git_diff_staged）
    let frameworkContext: string | undefined;
    if (workspaceRoot2) {
      const hasEmittedTree = this.context.workspaceState.get<boolean>(
        HAS_EMITTED_WORKSPACE_TREE_KEY,
        false,
      );
      const isFirstTurn = !hasEmittedTree;
      try {
        frameworkContext = await buildFrameworkContext({
          mode: this.modeManager.getCurrent(),
          isFirstTurn,
          workspaceRoot: workspaceRoot2,
          getActiveFile: () => {
            const ed = vscode.window.activeTextEditor;
            return ed ? vscode.workspace.asRelativePath(ed.document.uri, false) : undefined;
          },
          getOpenTabs: (): readonly OpenTabInfo[] => {
            const tabs: OpenTabInfo[] = [];
            const activeUri = vscode.window.activeTextEditor?.document.uri.fsPath;
            for (const group of vscode.window.tabGroups.all) {
              for (const tab of group.tabs) {
                const input = tab.input as { uri?: vscode.Uri } | undefined;
                const uri = input?.uri;
                if (!uri || uri.scheme !== 'file') continue;
                const rel = vscode.workspace.asRelativePath(uri, false);
                const info: OpenTabInfo = { path: rel };
                if (uri.fsPath === activeUri) info.active = true;
                if (tab.isDirty) info.dirty = true;
                tabs.push(info);
              }
            }
            return tabs;
          },
          getWorkspaceTree: async () => {
            if (!isFirstTurn) return undefined;
            const files = await vscode.workspace.findFiles(
              '**/*',
              '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.next/**,**/.turbo/**,**/coverage/**}',
              500,
            );
            return files.map((f) => vscode.workspace.asRelativePath(f, false)).join('\n');
          },
          getGitStatus: async () => {
            const r = await defaultGitCtxRunner(['status', '--porcelain=v1'], {
              cwd: workspaceRoot2,
              timeoutMs: 2000,
              maxBuffer: 256 * 1024,
            });
            return r.code === 0 ? r.stdout : undefined;
          },
          getGitDiffStaged: async () => {
            const r = await defaultGitCtxRunner(['diff', '--cached', '--stat'], {
              cwd: workspaceRoot2,
              timeoutMs: 2000,
              maxBuffer: 256 * 1024,
            });
            return r.code === 0 ? r.stdout : undefined;
          },
        });
        if (isFirstTurn && frameworkContext && frameworkContext.length > 0) {
          await this.context.workspaceState.update(HAS_EMITTED_WORKSPACE_TREE_KEY, true);
        }
      } catch (e) {
        log.warn({ err: String(e) }, 'buildSystemPrompt(frameworkContext) failed; continue');
      }
    }

    // M4 · 消费预取结果（下一轮 user 输入命中上一轮的预取）
    let prefetchBlock: string | undefined;
    if (this.prefetchEngine && options.userQuery) {
      const hit = this.prefetchEngine.consumeHit(options.userQuery);
      if (hit) prefetchBlock = hit;
    }

    // 冻结快照：传给 PromptBuilder 的是快照中的记录，而非全量 list()
    const snapshotMemories = this.frozenMemorySnapshot?.memories ?? [];
    const { full } = PromptBuilder.build({
      mode: this.modeManager.getCurrent(),
      skills,
      selectedRules,
      allRules,
      memories: snapshotMemories,
      taskContext,
      modelId: options.modelId,
      attachments: {
        // B-P3-1 · EnvironmentProbe → L3 注入 `<environment>` 块
        environment: buildEnvironmentBlock({
          ...(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            ? { workspaceRoot: vscode.workspace.workspaceFolders[0]!.uri.fsPath }
            : {}),
        }),
        // W13.3 · VLM OCR Policy（本次 turn 含图 → 注入；无图 → 零 token 成本）
        // 历史多轮会话含图但当前 turn 无图时不注入，恰好避开缓存击穿
        ...(options.hasVision
          ? { vlmOcrPolicy: buildVlmOcrBlock(true) }
          : {}),
        // B-P1-13 · M10.1 框架自动注入 4 块
        ...(frameworkContext && frameworkContext.length > 0
          ? { frameworkContext }
          : {}),
        // B-P1-10 · 选区右键「Ask」注入的 selected_codes
        ...(this.pendingSelectedCodes.length > 0
          ? { selectedCodes: this.pendingSelectedCodes }
          : {}),
        // B-P1-11 · git 上下文（优先 pending，其次自动采集）
        ...(gitContext
          ? { gitContext }
          : {}),
      },
    });
    return full;
  }

  /** 懒加载 / 初始化 CodebaseIndex（复用已有实例或创建新实例） */
  async getCodebaseIndex(): Promise<CodebaseIndexLike> {
    if (this.codebaseIndex) return this.codebaseIndex;
    if (this.codebaseIndexPromise) return this.codebaseIndexPromise;

    this.codebaseIndexPromise = this.initCodebaseIndex();
    this.codebaseIndex = await this.codebaseIndexPromise;
    this.codebaseIndexPromise = undefined;
    return this.codebaseIndex;
  }

  /**
   * W14.1 · 懒加载 KnowledgeIndex。
   *  - 目录缺失 → 抛 `KNOWLEDGE_BASE_EMPTY`，`search_knowledge` 工具据此软降级
   *  - 首次 create 后自动 reindex 一次（短文档，BM25 冷启动 < 100ms）
   *
   * 失败时清空 promise，下一次调用可以重试（例如用户刚创建了 knowledge 目录）。
   */
  async getKnowledgeIndex(): Promise<KnowledgeIndex> {
    if (this.knowledgeIndex) return this.knowledgeIndex;
    if (this.knowledgeIndexPromise) return this.knowledgeIndexPromise;

    this.knowledgeIndexPromise = this.initKnowledgeIndex().catch((e) => {
      this.knowledgeIndexPromise = undefined;
      throw e;
    });
    this.knowledgeIndex = await this.knowledgeIndexPromise;
    this.knowledgeIndexPromise = undefined;
    return this.knowledgeIndex;
  }

  private async initKnowledgeIndex(): Promise<KnowledgeIndex> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      throw new AgentError({
        code: ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        message: '未打开工作区，无法创建知识库索引',
      });
    }
    const idx = await KnowledgeIndex.create({ workspaceRoot });
    // 无 chunk 时自动建一次（store 损坏/首次使用）
    if (idx.size() === 0) {
      try {
        await idx.reindex();
      } catch (e) {
        log.warn({ err: (e as Error).message }, '[W14.1] knowledge reindex failed on first load');
      }
    }
    return idx;
  }

  private async initCodebaseIndex(): Promise<CodebaseIndexLike> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      throw new AgentError({
        code: ErrorCodes.TOOL_EXEC_PERMISSION_DENIED,
        message: '未打开工作区，无法创建代码库索引',
      });
    }
    const config = vscode.workspace.getConfiguration('devSeeker');
    const provider = (
      config.get<string>('codebaseIndex.embedProvider', 'local-bert') || 'local-bert'
    ).trim();
    // W13.4-C · BM25 provider 走 lexical 路径，完全绕过 embedder。
    if (provider === 'bm25') {
      const idx = await Bm25CodebaseIndex.create({
        workspaceRoot,
        storePath: defaultBm25IndexStorePath(workspaceRoot),
        onProgress: (p) => {
          try {
            this._indexProgressListener?.(p);
          } catch {
            /* ignore */
          }
        },
      });
      return idx;
    }
    const embedder = await this.buildEmbedderAsync(config);
    const idx = await CodebaseIndex.create({
      workspaceRoot,
      embedder,
      storePath: defaultIndexStorePath(workspaceRoot),
      // v1.2.2 · 转发到可替换的 listener（reindexCodebase 临时挂载）
      onProgress: (p) => {
        try {
          this._indexProgressListener?.(p);
        } catch {
          /* ignore */
        }
      },
    });
    return idx;
  }

  /** v1.2.2 · reindex 期间临时挂载的进度 listener */
  private _indexProgressListener?: (p: IndexProgress) => void;

  /**
   * v1.2.0 W13.5 · embedder 单例缓存。
   * - local-bert 首次加载 ONNX 模型需 5–10s，缓存避免每次 reindex 重载。
   * - DashScope 轻量（只是 HTTP client），也统一缓存让 buildEmbedderSync 可复用。
   */
  private _embedderCache?: Embedder;

  /**
   * 异步构造 embedder（reindex / 手动检索路径专用）。
   * 根据 `codebaseIndex.embedProvider` 分派：local-bert / dashscope。
   */
  private async buildEmbedderAsync(
    config: vscode.WorkspaceConfiguration,
  ): Promise<Embedder> {
    if (this._embedderCache) return this._embedderCache;
    const provider = (
      config.get<string>('codebaseIndex.embedProvider', 'local-bert') || 'local-bert'
    ).trim();
    if (provider === 'local-bert') {
      // modelDir 传的是「父目录」，hfId 由 transformers.js 拼接。
      // 真实模型路径：<ext>/models/Xenova/multilingual-e5-small/
      const modelDir = path.join(this.context.extensionPath, 'models');
      const embedder = await WorkerEmbedder.create({ modelDir, extensionPath: this.context.extensionPath });
      this._embedderCache = embedder;
      return embedder;
    }
    // dashscope
    const embedder = this.buildDashScopeEmbedder(config);
    this._embedderCache = embedder;
    return embedder;
  }

  /**
   * 同步构造 embedder（fetch_content::getEmbedder 回调专用）。
   * - 已缓存 → 直接返回
   * - local-bert 未预热 → 返回 undefined（fetch_content relevance 会自动 fallback 到关键词策略）
   * - dashscope → 同步构造 client
   */
  private buildEmbedderSync(
    config: vscode.WorkspaceConfiguration,
  ): Embedder | undefined {
    if (this._embedderCache) return this._embedderCache;
    const provider = (
      config.get<string>('codebaseIndex.embedProvider', 'local-bert') || 'local-bert'
    ).trim();
    if (provider !== 'dashscope') return undefined;
    try {
      const embedder = this.buildDashScopeEmbedder(config);
      this._embedderCache = embedder;
      return embedder;
    } catch {
      return undefined;
    }
  }

  private buildDashScopeEmbedder(
    config: vscode.WorkspaceConfiguration,
  ): DashScopeEmbedder {
    const apiKey = config.get<string>('qwenVl.apiKey', '').trim();
    if (!apiKey) {
      throw new AgentError({
        code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY,
        message:
          '建立代码库索引需要 DashScope API Key。请在 VSCode 设置中填入 devSeeker.qwenVl.apiKey（与 Qwen-VL 共用同一密钥）。',
      });
    }
    const baseUrl = config.get<string>('qwenVl.baseUrl', '').trim();
    const model = config.get<string>('codebaseIndex.embedModel', 'text-embedding-v3').trim();
    const dimension = config.get<number>('codebaseIndex.embedDimension', 1024);
    const batchSize = config.get<number>('codebaseIndex.embedBatchSize', 10);
    // v1.0.2：允许用户覆盖超时时间（默认 60s），用于 DashScope 冷启动 / 慢网络场景
    const timeoutMs = config.get<number>('codebaseIndex.embedTimeoutMs', 60000);
    return new DashScopeEmbedder({
      apiKey,
      baseUrl: baseUrl || undefined,
      model,
      dimension,
      batchSize,
      timeoutMs,
    });
  }

  // ─────────── Mode 调度（W6b1） ───────────

  private pushModeStatus(reason?: string): void {
    const payload: ModeStatusPayload = {
      current: this.modeManager.getCurrent(),
      available: ALL_MODES.map((m) => ({
        id: m,
        label: MODE_INFO[m].label,
        description: MODE_INFO[m].description,
      })),
      ...(reason ? { lastChangeReason: reason } : {}),
      planReady: this.planReadyForSwitch || undefined,
    };
    this.post({ type: 'mode_status', payload });
  }

  /** 用户从 Webview 下拉手动切 Mode */
  private handleSetModeFromUser(mode: Mode): void {
    const changed = this.modeManager.setMode(mode, 'user_selected');
    if (changed) {
      log.info({ mode }, 'mode switched by user');
      this.planReadyForSwitch = false;
    }
    this.pushModeStatus(changed ? 'user_selected' : undefined);
  }

  /**
   * switch_mode 工具的审批回调：自动切换模式，无需弹窗确认。
   * Plan 是当前允许的唯一目标（见 SwitchModeTool）。
   */
  private async approveSwitchMode(
    targetMode: Mode,
    _explanation: string | undefined,
  ): Promise<boolean> {
    if (this.modeManager.getCurrent() === targetMode) return true;
    // 自动切换，不弹窗
    this.modeManager.setMode(targetMode, 'switch_mode_tool_approved');
    this.pushModeStatus('switch_mode_tool_approved');
    log.info({ targetMode }, 'mode auto-switched by switch_mode tool');
    return true;
  }

  /**
   * create_plan 工具写盘成功后的回调（W6b2）。
   * 记录 planDoc 到 ModeManager；下一轮 user 消息会自动注入该路径。
   * 同时弹出模态"审阅并批准"，批准时自动切回 Agent 模式。
   * v1.6.0 · 改为 await 等待用户决策，防止 Agent 在用户未审批前继续执行。
   */
  private async onPlanWritten(absPath: string): Promise<void> {
    this.modeManager.setPlanDoc(absPath);
    this.pushModeStatus('plan_written');
    // v1.6.0 · 阻塞等待用户审批决策，防止未审批就继续执行
    await this.promptApprovePlan(absPath);
  }

  /**
   * 向用户弹窗"审阅并批准 Plan"。
   * - 选中"批准并切回 Agent" → 立即切回 Agent，planDoc 等下一轮注入
   * - 选中"继续在 Plan 模式打磨" → 保持在 Plan 模式，在 UI 头部展示"切换到 Agent"按钮
   *   用户点击按钮后才切回 Agent（参见 handleSwitchToAgentAfterPlan）
   */
  private async promptApprovePlan(absPath: string): Promise<void> {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const rel = wsRoot ? vscode.workspace.asRelativePath(absPath) : absPath;
    const picked = await vscode.window.showInformationMessage(
      `DevSeeker 已产出 Plan 文档：${rel}`,
      { modal: true, detail: '请先打开文件审阅；批准后会自动切回 Agent 模式并把 Plan 路径交给下一轮执行。' },
      '批准并切回 Agent',
      '继续在 Plan 模式打磨',
    );
    if (picked === '批准并切回 Agent') {
      const changed = this.modeManager.setMode('agent', 'plan_approved');
      if (changed) log.info({ planDoc: absPath }, 'plan approved, switched back to agent');
      this.pushModeStatus('plan_approved');
    } else {
      // 保持在 Plan 模式，在 UI 头部展示"切换到 Agent 执行"按钮
      this.planReadyForSwitch = true;
      this.pushModeStatus('plan_ready_waiting');
    }
  }

  /** Plan 模式下用户在 UI 点击"切换到 Agent 执行"按钮 */
  private handleSwitchToAgentAfterPlan(): void {
    if (!this.planReadyForSwitch) return;
    this.planReadyForSwitch = false;
    const changed = this.modeManager.setMode('agent', 'plan_approved');
    if (changed) log.info({ planDoc: this.modeManager.snapshot().planDoc }, 'user clicked switch to agent after plan');
    this.pushModeStatus('plan_approved');
  }

  /**
   * 消耗 planDoc：返回 plan 文档前缀文本，并缓存 planXml 供 PromptBuilder 消费。
   * 在下一轮 runWithProvider 发起前调用。
   * Phase 5 Phase D：集成 plan-injector 将 plan 解析为 XML 追加到 system prompt。
   */
  private consumePlanDocPrefix(): string | null {
    const snap = this.modeManager.snapshot();
    if (!snap.planDoc) return null;
    const planDoc = snap.planDoc;
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.modeManager.setPlanDoc(undefined);
    this.pushModeStatus('plan_doc_consumed');
    // 异步读取 plan 文件生成 XML，供 PromptSnippetProvider 消费
    if (wsRoot) {
      formatApprovedPlanXml(planDoc, wsRoot)
        .then((xml) => {
          if (xml) this.cachedPlanXml = xml;
        })
        .catch(() => { /* 静默失败 */ });
    }
    return `📋 Plan document: ${planDoc}\n请按此计划执行。\n\n`;
  }

  /** Phase 5 Phase D · 缓存的 approve_plan XML，由 PromptBuilder 消费 */
  private cachedPlanXml: string | undefined;

  /** Phase 5 Phase D M2 · 冻结记忆快照（session 启动时构建，整 session 不更新） */
  private frozenMemorySnapshot: import('../core/memory/snapshot.js').FrozenSnapshot | undefined = undefined;

  /** Phase 5 Phase D M4 · 后台预取引擎 */
  private prefetchEngine: PrefetchEngine | undefined;

  /**
   * 从 VSCode config 构建联网搜索 ProviderRegistry（W6b3 + W8.11）。
   * 每次调用都读最新配置，使 apiKeys 变更无需重启。
   * - W8.11：注册 Bing（有 key 时）+ DuckDuckGo（无需 key，作为兆底 provider）
   * - 多 Key 支持：apiKeys 数组支持多 Key，自动 Pool + failover
   */
  private buildWebSearchRegistry(): WebSearchRegistry {
    const cfg = vscode.workspace.getConfiguration('devSeeker.webResearch');
    const tavilyKeysRaw = cfg.get<string[]>('tavily.apiKeys') ?? [];
    const bochaKeysRaw = cfg.get<string[]>('bocha.apiKeys') ?? [];
    const bingKey = cfg.get<string>('bing.apiKey')?.trim() ?? '';
    const enableDdg = cfg.get<boolean>('duckduckgo.enabled') ?? true;
    const defaultProvider = (cfg.get<string>('defaultProvider')?.trim() ?? 'auto') as
      | SearchProviderId
      | 'auto';
    const providers = new Map<SearchProviderId, ISearchProvider>();

    // 过滤空值
    const tavilyKeyList = tavilyKeysRaw.filter((k) => k.trim());
    const bochaKeyList = bochaKeysRaw.filter((k) => k.trim());

    // ── Tavily：Pool 单例，配置变更时才重建 ──
    const tavilyKeysSnapshot = JSON.stringify(tavilyKeyList);
    if (tavilyKeyList.length > 1) {
      if (tavilyKeysSnapshot !== this.tavilyApiKeysSnapshot || !this.tavilyKeyPool) {
        this.tavilyKeyPool = new ApiKeyPool(tavilyKeyList);
        this.tavilyApiKeysSnapshot = tavilyKeysSnapshot;
      }
      providers.set('tavily', new TavilyProvider({ apiKey: tavilyKeyList[0]!, keyPool: this.tavilyKeyPool }));
    } else if (tavilyKeyList.length === 1) {
      providers.set('tavily', new TavilyProvider({ apiKey: tavilyKeyList[0]! }));
      this.tavilyKeyPool = undefined;
      this.tavilyApiKeysSnapshot = '';
    }

    // ── Bocha：Pool 单例，配置变更时才重建 ──
    const bochaKeysSnapshot = JSON.stringify(bochaKeyList);
    if (bochaKeyList.length > 1) {
      if (bochaKeysSnapshot !== this.bochaApiKeysSnapshot || !this.bochaKeyPool) {
        this.bochaKeyPool = new ApiKeyPool(bochaKeyList);
        this.bochaApiKeysSnapshot = bochaKeysSnapshot;
      }
      providers.set('bocha', new BochaProvider({ apiKey: bochaKeyList[0]!, keyPool: this.bochaKeyPool }));
    } else if (bochaKeyList.length === 1) {
      providers.set('bocha', new BochaProvider({ apiKey: bochaKeyList[0]! }));
      this.bochaKeyPool = undefined;
      this.bochaApiKeysSnapshot = '';
    }

    if (bingKey) providers.set('bing', new BingProvider({ apiKey: bingKey }));
    if (enableDdg) providers.set('duckduckgo', new DuckDuckGoProvider());
    return { providers, defaultProvider };
  }

  /**
   * 从 VSCode config 构建 FetchContentTool 依赖（W6b3 + W8.9 + W8.10）。
   * - W8.9：注入 getEmbedder 以支持语义 relevance；若未配置 DashScope key 则 relevance 自动 fallback 到关键词策略。
   * - W8.10：提供缓存 TTL + QPS 限流配置（默认 1h / 5 rps）。
   */
  private buildFetchContentDeps() {
    const cfg = vscode.workspace.getConfiguration('devSeeker.webResearch');
    const cacheTtlSec = cfg.get<number>('fetch.cacheTtlSec') ?? 3600;
    const rps = cfg.get<number>('fetch.qps') ?? 5;
    return {
      useJinaReader: cfg.get<boolean>('useJinaReader') ?? true,
      blocklist: cfg.get<string[]>('blocklist') ?? [],
      cacheTtlMs: cacheTtlSec * 1000,
      rps,
      getEmbedder: (): Embedder | undefined => {
        try {
          return this.buildEmbedderSync(vscode.workspace.getConfiguration('devSeeker'));
        } catch {
          return undefined;
        }
      },
    };
  }

  /**
   * 构建 SubagentRunner 依赖（W6b4）。
   * - provider：优先用当前 activeProvider；否则从 registry 按 defaultProvider 回退
   * - toolRegistry：共享主 registry（Runner 内用 toolFilter 按白名单裁剪）
   */
  private buildSubagentRunnerDeps(): SubagentRunnerDeps {
    const registry = getProviderRegistry();
    let provider: IProvider | undefined;
    if (this.activeProviderId) {
      provider = registry.get(this.activeProviderId);
    }
    if (!provider) {
      provider = registry.getDefaultProvider('llm');
    }
    if (!provider) {
      throw new AgentError({
        code: ErrorCodes.SUBAGENT_FAILED,
        message: '无可用 Provider，请先在 DevSeeker 设置中填入 API Key。',
      });
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // v1.6.0 · 传入 contextWindow，让子代理 ContextManager 能正确压缩
    const contextWindow = (provider as any)?.contextWindow ?? undefined;
    // Vision SubAgent 专用：从 vllm track 获取视觉模型 provider
    const visionProvider = registry.getDefaultProvider('vllm');
    return {
      provider,
      toolRegistry: this.toolRegistry,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(visionProvider ? { visionProvider } : {}),
    };
  }

  // ─────────── Checkpoint 命令入口（W5b2b） ───────────

  /**
   * 列出当前 session 的 checkpoint 元信息（按 createdAt 升序）。
   * 无 session / 无工作区 → 返回 []。
   */
  async listCheckpoints(): Promise<CheckpointMeta[]> {
    const coordinator = this.getCheckpointCoordinator();
    if (!coordinator || !this.currentSession) return [];
    return coordinator.list(this.currentSession.id);
  }

  /** 返回当前 session id，供侧边栏 TreeView 判空使用 */
  getCurrentSessionId(): string | undefined {
    return this.currentSession?.id;
  }

  /** 重新激活已失效的搜索 API Key（Tavily/Bocha） */
  reactivateSearchKeys(): { tavily: number; bocha: number } {
    const tavily = this.tavilyKeyPool?.reactivateAll() ?? 0;
    const bocha = this.bochaKeyPool?.reactivateAll() ?? 0;
    log.info({ tavily, bocha }, 'reactivated search API keys');
    return { tavily, bocha };
  }

  /** 暂停当前正在执行的 Agent 任务（保存上下文，可后续继续） */
  pauseTask(): void {
    const loop = this.taskLoop;
    if (!loop || !this.activeProviderId) return;

    // 保存暂停上下文
    this.pausedContext = {
      userInput: '[用户暂停后继续]',
      priorMessages: loop.getHistorySnapshot(),
      providerId: this.activeProviderId,
      modelOverride: undefined,
    };

    // 中止当前 loop
    loop.abort();
    try { this.terminalManager.killAll(); } catch { /* ignore */ }

    log.info({ taskId: loop.taskId }, 'TaskLoop paused by user');
  }

  /** 继续暂停的 Agent 任务（用保存的历史创建新 loop 继续对话） */
  async resumeTask(): Promise<void> {
    if (!this.pausedContext) {
      vscode.window.showWarningMessage('DevSeeker: 没有可继续的任务');
      return;
    }

    const ctx = this.pausedContext;
    this.pausedContext = null;

    // 查找暂停时的 Provider
    const registry = getProviderRegistry();
    const provider = registry.get(ctx.providerId);
    if (!provider) {
      vscode.window.showErrorMessage('DevSeeker: 暂停时的 Provider 不可用，请手动发送新指令');
      return;
    }

    this.activeProviderId = provider.id;

    // 清理旧 taskLoop
    if (this.taskLoop) {
      this.taskLoop.abort();
      this.taskLoop = null;
    }

    // 用保存的历史继续对话
    await this.runWithProvider(
      provider,
      ctx.userInput,
      ctx.priorMessages,
      'resume-from-pause',
      ctx.images,
      undefined,
      ctx.modelOverride,
    );
  }

  /** B-P1-5 · Context 面板使用，暴露当前 Mode（只读） */
  getCurrentMode() {
    return this.modeManager.getCurrent();
  }

  /** B-P1-6 · Cost Panel 使用，暴露当前 CostSummary 有效载荷（只读） */
  getCostSummaryPayload(): CostSummaryPayload {
    const s = this.costTracker.summary();
    const today = this.costTracker.todayCost();
    return {
      session: { ...s.session },
      total: { ...s.total },
      today: { CNY: today.CNY, USD: today.USD },
      byProvider: s.byProvider.map((x) => ({ ...x })),
    };
  }

  /** B-P1-16 · Cost Panel 使用，暴露当前 UsageStore（SQLite 只读接口） */
  getUsageStore(): SqliteUsageStore {
    return this.usageStore;
  }

  /** 定向删除一个 checkpoint，返回 true 表示确实移除 */
  async deleteCheckpoint(id: string): Promise<boolean> {
    const coordinator = this.getCheckpointCoordinator();
    if (!coordinator || !this.currentSession) return false;
    return coordinator.delete(id, this.currentSession.id);
  }

  /**
   * B-P1-15 · Checkpoints 时间线面板使用：
   * 读取某 checkpoint 的完整 payload（含 fileSnapshots），用于 Compare Diff。
   * 无 coordinator / 无 session → undefined。
   */
  async getCheckpointDetails(id: string): Promise<import('../core/checkpoints/index.js').Checkpoint | undefined> {
    const coordinator = this.getCheckpointCoordinator();
    if (!coordinator || !this.currentSession) return undefined;
    return coordinator.get(id, this.currentSession.id);
  }

  /**
   * 恢复某 checkpoint：
   * 1. store.revert 应用文件 + 取出 messages
   * 2. 写回 currentSession.messages + sessionStore
   * 3. 丢弃当前 taskLoop，向 webview 推送 history
   * 返回 undefined 当不可用（无 session / 无工作区）。
   */
  async revertCheckpoint(id: string): Promise<RevertResult | undefined> {
    const coordinator = this.getCheckpointCoordinator();
    if (!coordinator || !this.currentSession) return undefined;
    const sessionId = this.currentSession.id;
    const result = await coordinator.revert({ id, sessionId });

    // 丢弃当前 loop，避免 revert 中途继续追加消息
    this.taskLoop?.abort();
    this.taskLoop = null;
    this.costTracker.resetSession();

    // 替换 session messages 并回写
    const now = Date.now();
    const nextSession: StoredSession = {
      ...this.currentSession,
      updatedAt: now,
      messages: result.messages.filter((m) => m.role !== 'system'),
      sessionCost: this.costTracker.summary().byProvider,
    };
    this.currentSession = nextSession;
    try {
      await this.sessionStore.saveSession(nextSession);
    } catch (e) {
      log.warn({ err: String(e) }, 'saveSession after revert failed');
    }

    // 推送 history 给 webview
    this.post({
      type: 'history',
      sessionId: nextSession.id,
      messages: nextSession.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
        .map((m) => ({
          role: m.role,
          content:
            typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? m.content
                    .filter((p) => p.type === 'text')
                    .map((p) => (p.type === 'text' ? p.text : ''))
                    .join('\n')
                : '',
        })),
    });
    this.pushSessionList();
    this.pushCostSummary();
    // 通知 Checkpoints 侧边栏刷新（W5b3）
    void vscode.commands.executeCommand('devSeeker.checkpoints.refresh');
    return result;
  }

  /** 命令入口：重建索引（带 VSCode 进度条 + webview 进度推送） */
  async reindexCodebase(): Promise<void> {
    const idx = await this.getCodebaseIndex();
    // B-1.0.1-D · 手动重建开始时状态栏置 indexing
    setIndexStatusBar('indexing', { message: '正在重建索引…' });
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'DevSeeker：建立代码库语义索引',
        cancellable: true,
      },
      async (progress, token) => {
        const ctl = new AbortController();
        token.onCancellationRequested(() => ctl.abort());
        // v1.2.2 · 接进度事件 → vscode 进度条 + 状态栏 + 日志
        const startedAt = Date.now();
        let lastChunksDone = 0;
        let lastLogged = 0;
        this._indexProgressListener = (p): void => {
          let pct = 0;
          let msg = '';
          if (p.phase === 'scanning') {
            msg = '扫描工作区…';
          } else if (p.phase === 'chunking') {
            msg = `切块 ${p.filesDone}/${p.filesTotal} files…`;
          } else if (p.phase === 'embedding') {
            const total = p.chunksTotal || 1;
            pct = Math.min(99, (p.chunksDone / total) * 100);
            const elapsed = (Date.now() - startedAt) / 1000;
            const rate = p.chunksDone > 0 ? p.chunksDone / elapsed : 0;
            const etaSec = rate > 0 ? Math.max(0, (total - p.chunksDone) / rate) : 0;
            const eta =
              etaSec > 60 ? `${Math.round(etaSec / 60)}m` : `${Math.round(etaSec)}s`;
            msg = `向量化 ${p.chunksDone}/${total} (${pct.toFixed(0)}%, ETA ~${eta})`;
          } else if (p.phase === 'saving') {
            pct = 99;
            msg = '写入磁盘…';
          } else if (p.phase === 'done') {
            pct = 100;
            msg = p.message ?? '完成';
          }
          // 增量 increment
          const inc = pct > lastChunksDone ? pct - lastChunksDone : 0;
          lastChunksDone = pct;
          progress.report({ message: msg, increment: inc });
          // 状态栏同步亜文本
          setIndexStatusBar('indexing', { message: msg });
          // 日志限频：embedding 阶段每 5% 打一条，避免洪水
          if (p.phase === 'embedding' && pct - lastLogged >= 5) {
            lastLogged = pct;
            log.info(
              { phase: p.phase, chunksDone: p.chunksDone, chunksTotal: p.chunksTotal, pct: Math.round(pct) },
              `[索引] ${msg}`,
            );
          } else if (p.phase !== 'embedding') {
            log.info({ phase: p.phase }, `[索引] ${msg}`);
          }
        };
        try {
          const stats = await idx.reindex();
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '(未知)';
        // W7d3 · 持久化本次扫描到的文件数，供 pushIndexStatus / 黄条识别"空工作区"
        await this.context.workspaceState.update(
          LAST_REINDEX_FILES_SCANNED_KEY,
          stats.filesScanned,
        );
        // W7d2 · files=0 时用 Warning 而不是 Info，并给出诊断提示
        if (stats.filesScanned === 0) {
          // B-1.0.1-C · 将前 10 条被过滤样本拼接到诊断文案
          const sampleBlock =
            stats.filterSamples.length === 0
              ? '诊断样本：（根目录下亦无任何可采样条目、很可能确为空工作区）'
              : '诊断样本（前 ' +
                stats.filterSamples.length +
                ' 条被过滤条目）：\n' +
                stats.filterSamples
                  .map((s) => `  · [${s.reason}${s.detail ? ':' + s.detail : ''}] ${s.relPath}`)
                  .join('\n');
          const msg =
            `索引扫到 0 个源码文件（工作区: ${workspaceRoot}），索引未建立。\n` +
            `可能原因：\n` +
            `  (a) 当前 VSCode 未打开代码项目（File > Open Folder… 选择项目根目录）；\n` +
            `  (b) 工作区根目录下只有 zip/msi/exe 等非源码文件，子目录 .ts/.js/.py 等都被你想索引的单项目，需要重新 Open Folder 选到具体项目；\n` +
            `  (c) 工作区全被过滤目录占据（node_modules/.git/dist 等）。\n` +
            `白名单扩展名见 src/core/index/scanner.ts DEFAULT_INCLUDE_EXT。\n\n` +
            sampleBlock;
          void vscode.window.showWarningMessage(msg, { modal: false });
        } else {
          const msg = `索引完成：${stats.chunksEmbedded} chunks / ${stats.filesScanned} files，耗时 ${(stats.durationMs / 1000).toFixed(1)}s`;
          void vscode.window.showInformationMessage(msg);
        }
        this.pushIndexStatus();
        } finally {
          this._indexProgressListener = undefined;
        }
      },
    );
  }

  /** 注册文件保存监听器，做增量索引更新 */
  private registerFileWatcher(): void {
    // B-P2-4 · 用于包含外部改动（git pull / 外部编辑器）的索引塑念 IndexWatcher；
    // onDidSaveTextDocument 仍保留，用于 Rules/Skills/Hooks 配置的即时失效。
    const codeExts = new Set([
      '.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.go','.rs','.java',
      '.kt','.c','.h','.cpp','.hpp','.cc','.cs','.swift','.rb','.php',
      '.vue','.svelte','.html','.css','.scss','.less','.json','.yml','.yaml',
      '.toml','.md','.sh','.ps1',
    ]);
    const isCodeFile = (relPath: string): boolean => {
      const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
      return codeExts.has(ext);
    };
    const indexWatcher = new IndexFileWatcher({
      getIndex: async () => {
        try { return await this.getCodebaseIndex(); } catch { return undefined; }
      },
      isCodeFile,
      onError: (err, file, op) => log.warn({ err: String(err), file, op }, 'IndexWatcher op failed'),
      debounceMs: 2000,
    });
    this.disposables.push({ dispose: () => indexWatcher.dispose() });

    // 全工作区文件监听（包含外部改动）
    const fsWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    const toRel = (uri: vscode.Uri): string | undefined => {
      const rel = vscode.workspace.asRelativePath(uri, false);
      return rel || undefined;
    };
    this.disposables.push(
      fsWatcher,
      fsWatcher.onDidCreate((uri) => {
        const rel = toRel(uri);
        if (rel) indexWatcher.schedule(rel, 'update');
      }),
      fsWatcher.onDidChange((uri) => {
        const rel = toRel(uri);
        if (rel) indexWatcher.schedule(rel, 'update');
      }),
      fsWatcher.onDidDelete((uri) => {
        const rel = toRel(uri);
        if (rel) indexWatcher.schedule(rel, 'remove');
      }),
    );

    // 保留：onDidSaveTextDocument 用于 Rules/Skills/Hooks 的即时失效（需要内容同步），
    // 源码增量索引已走 fsWatcher 通路，此处不再重复调。
    const saveWatcher = vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) return;
      const relPath = vscode.workspace.asRelativePath(doc.uri, false);
      if (!relPath) return;

      // Rules 文件变更 → 失效规则缓存，下次 send 时重读
      if (/^[.]devseeker[\\/]rules[\\/].+\.mdx?$/i.test(relPath)) {
        this.ruleLoader?.invalidate();
      }

      // Skills 文件变更 → 失效技能缓存
      if (/^[.]devseeker[\\/]skills[\\/].+\.mdx?$/i.test(relPath)) {
        this.skillLoader?.invalidate();
      }

      // Hooks 配置变更 → 丢弃 HookManager，下次 send 时重读
      if (/^[.]devseeker[\\/]hooks\.json$/i.test(relPath)) {
        log.info('hooks.json changed; hook manager will reload on next send');
        this.hookManager = undefined;
      }
    });
    this.disposables.push(saveWatcher);
  }

  // ─────────── W7b4b · ask_user_question + Diff 预览 ───────────

  /**
   * AskUserQuestionTool 的 bridge：推 `ask_question` 到 webview，等用户回填或 abort。
   */
  private requestAskQuestion(
    requestId: string,
    questions: AskQuestionItem[],
    signal: AbortSignal,
  ): Promise<AskUserQuestionResponse> {
    return new Promise<AskUserQuestionResponse>((resolve, reject) => {
      if (signal.aborted) {
        resolve({ answers: [], cancelled: true });
        return;
      }
      const onAbort = () => {
        const entry = this.askPending.get(requestId);
        if (!entry) return;
        this.askPending.delete(requestId);
        try {
          entry.signal.removeEventListener('abort', entry.onAbort);
        } catch {
          /* ignore */
        }
        resolve({ answers: [], cancelled: true });
      };
      this.askPending.set(requestId, { resolve, reject, onAbort, signal });
      signal.addEventListener('abort', onAbort, { once: true });
      this.post({
        type: 'ask_question',
        payload: { requestId, questions },
      });
      log.info({ requestId, count: questions.length }, 'ask_question posted to webview');
    });
  }

  /** webview 把 ask_user_question 的回复传回来 */
  private handleAskQuestionResponse(
    requestId: string,
    answers: Array<{ question: string; selected: string[]; other?: string }>,
    cancelled?: boolean,
  ): void {
    const entry = this.askPending.get(requestId);
    if (!entry) {
      log.warn({ requestId }, 'ask_question_response for unknown requestId; drop');
      return;
    }
    this.askPending.delete(requestId);
    try {
      entry.signal.removeEventListener('abort', entry.onAbort);
    } catch {
      /* ignore */
    }
    entry.resolve({ answers, ...(cancelled ? { cancelled: true } : {}) });
  }

  /** 取消所有 pending ask（session 切换 / panel dispose） */
  private cancelAllPendingAsk(reason: string): void {
    if (this.askPending.size === 0) return;
    log.info({ count: this.askPending.size, reason }, 'cancel all pending ask');
    for (const [, entry] of this.askPending) {
      try {
        entry.signal.removeEventListener('abort', entry.onAbort);
      } catch {
        /* ignore */
      }
      entry.resolve({ answers: [], cancelled: true });
    }
    this.askPending.clear();
  }

  /** webview 把审批响应传回来 */
  private handleApprovalResponse(
    requestId: string,
    decision: 'allow_once' | 'remember' | 'deny' | 'redirect_terminal',
  ): void {
    const entry = this.approvalPending.get(requestId);
    if (!entry) {
      log.warn({ requestId }, 'approval_response for unknown requestId; drop');
      return;
    }
    this.approvalPending.delete(requestId);
    if (decision === 'remember') {
      const memoryKey = `approval:${entry.toolName}`;
      this.approvedExternalTools.add(memoryKey);
      entry.resolve({ approved: true, remember: true });
    } else if (decision === 'allow_once') {
      entry.resolve({ approved: true });
    } else if (decision === 'redirect_terminal') {
      // 用户选择"终端运行"：返回 redirected=true，ToolRunner 会注入
      // terminalMode='user_visible' 后正常调 BashTool.execute()。
      entry.resolve({ approved: true, redirected: true });
    } else {
      entry.resolve({ approved: false });
    }
  }

  /** 取消所有 pending approval（session 切换 / panel dispose） */
  private cancelAllPendingApprovals(reason: string): void {
    if (this.approvalPending.size === 0) return;
    log.info({ count: this.approvalPending.size, reason }, 'cancel all pending approvals');
    for (const [, entry] of this.approvalPending) {
      entry.resolve({ approved: false });
    }
    this.approvalPending.clear();
  }

  /**
   * W9.14 · Markdown file:/// 链接点击 → 打开对应文件，可选跳到指定行。
   * 安全策略：路径允许绝对路径或工作区相对路径；
   * 严限制在当前工作区或用户级目录下，避免 webview 通过消息反射任意读文件。
   */
  private async handleOpenFile(
    targetPath: string,
    lineStart?: number,
    lineEnd?: number,
  ): Promise<void> {
    if (!targetPath || typeof targetPath !== 'string') return;
    let absPath = targetPath;
    if (!path.isAbsolute(absPath)) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        log.warn({ targetPath }, 'open_file: no workspace root to resolve relative path');
        return;
      }
      absPath = path.join(root, absPath);
    }
    try {
      const uri = vscode.Uri.file(absPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const opts: vscode.TextDocumentShowOptions = { preview: false };
      if (typeof lineStart === 'number' && lineStart > 0) {
        const startLine = Math.max(0, lineStart - 1);
        const endLine =
          typeof lineEnd === 'number' && lineEnd >= lineStart ? lineEnd - 1 : startLine;
        const startPos = new vscode.Position(startLine, 0);
        const endPos = new vscode.Position(endLine, Number.MAX_SAFE_INTEGER);
        opts.selection = new vscode.Range(startPos, endPos);
      }
      await vscode.window.showTextDocument(doc, opts);
    } catch (e) {
      log.warn({ err: String(e), absPath }, 'open_file: failed to open');
      void vscode.window.showWarningMessage(`无法打开文件：${absPath}`);
    }
  }

  /**
   * W11.4 · 处理 webview 的 open_preview 请求——调用 vscode.env.openExternal
   * 打开外部浏览器。
   * 安全：仅允许 http/https；仅允许 localhost / 内网 （与 RunPreviewTool 同步）。
   */
  private async handleOpenPreview(url: string): Promise<void> {
    if (!url || typeof url !== 'string') return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      log.warn({ url }, 'open_preview: invalid URL');
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      log.warn({ url }, 'open_preview: rejected non-http(s) URL');
      return;
    }
    // 仅允许 localhost 类主机，与 RunPreviewTool 同策略
    const host = parsed.hostname.toLowerCase();
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
    if (!isLocal) {
      log.warn({ host }, 'open_preview: rejected non-local host');
      return;
    }
    try {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (e) {
      log.warn({ err: String(e), url }, 'open_preview: openExternal failed');
    }
  }

  /**
   * W7b4b · 处理 webview 的 revert_step 请求。
   * 走现有 revertCheckpoint 流程（它会 apply files + 重置 session messages + 推 history）。
   */
  private async handleRevertStep(checkpointId: string): Promise<void> {
    try {
      const result = await this.revertCheckpoint(checkpointId);
      if (!result) {
        this.post({
          type: 'revert_step_result',
          checkpointId,
          ok: false,
          message: '当前无可恢复的 checkpoint（未打开工作区或无 session）',
        });
        return;
      }
      this.post({
        type: 'revert_step_result',
        checkpointId,
        ok: true,
        message: `已恢复 ${result.filesApplied} 个文件（删除 ${result.filesDeleted} 个，跳过 ${result.filesSkipped} 个）`,
      });
    } catch (e) {
      const err = toAgentError(e);
      this.post({
        type: 'revert_step_result',
        checkpointId,
        ok: false,
        message: err.toUserMessage(),
      });
    }
  }

  /**
   * cleanupCheckpointsOnAccept · 单文件 accept 后清理关联的 step checkpoint。
   *
   * 删除 label 以 "step:" 开头且 fileSnapshots 中只有一个文件且 relPath 匹配的 checkpoint。
   * turn-level checkpoint（含多个文件）不做处理。
   */
  private async cleanupCheckpointsOnAccept(acceptedRelPath: string): Promise<number> {
    const coordinator = this.getCheckpointCoordinator();
    if (!coordinator || !this.currentSession) return 0;
    const sessionId = this.currentSession.id;
    let removed = 0;
    try {
      const metas = await coordinator.list(sessionId);
      for (const meta of metas) {
        if (!meta.label || !meta.label.startsWith('step:')) continue;
        const cp = await coordinator.get(meta.id, sessionId);
        if (!cp) continue;
        // step checkpoint 只关联一个文件
        if (cp.fileSnapshots.length !== 1) continue;
        const snap = cp.fileSnapshots[0];
        if (snap.relPath === acceptedRelPath) {
          const ok = await coordinator.delete(meta.id, sessionId);
          if (ok) removed++;
        }
      }
    } catch (e) {
      log.warn({ err: String(e), relPath: acceptedRelPath }, 'cleanupCheckpointsOnAccept failed');
    }
    if (removed > 0) {
      log.info({ count: removed, relPath: acceptedRelPath }, 'cleaned up step checkpoints on accept');
    }
    return removed;
  }

  /**
   * cleanupAllStepCheckpoints · accept all 后清理所有 step checkpoint。
   * 仅删除 label 以 "step:" 开头的 checkpoint，turn-level 的保留。
   */
  private async cleanupAllStepCheckpoints(): Promise<number> {
    const coordinator = this.getCheckpointCoordinator();
    if (!coordinator || !this.currentSession) return 0;
    const sessionId = this.currentSession.id;
    let removed = 0;
    try {
      const metas = await coordinator.list(sessionId);
      for (const meta of metas) {
        if (!meta.label || !meta.label.startsWith('step:')) continue;
        const ok = await coordinator.delete(meta.id, sessionId);
        if (ok) removed++;
      }
    } catch (e) {
      log.warn({ err: String(e) }, 'cleanupAllStepCheckpoints failed');
    }
    if (removed > 0) {
      log.info({ count: removed }, 'cleaned up all step checkpoints on accept all');
    }
    return removed;
  }

  /**
   * W15.6 · 处理 webview 的 revert_hunk 请求。
   * 解析 hunk unified diff，在当前文件上执行精确回滚。
   */
  private async handleRevertHunk(relPath: string, hunkUnified: string, nonce: string): Promise<void> {
    try {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!wsRoot) {
        void vscode.window.showErrorMessage('未打开工作区，无法回滚 hunk');
        this.post({ type: 'revert_hunk_result', nonce, ok: false, message: '未打开工作区' });
        return;
      }
      const absPath = path.resolve(wsRoot, relPath);
      // 安全校验：必须在工作区内
      const relCheck = path.relative(wsRoot, absPath);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        void vscode.window.showErrorMessage('文件路径超出工作区范围');
        this.post({ type: 'revert_hunk_result', nonce, ok: false, message: '路径超出工作区' });
        return;
      }

      const parsed = parseUnifiedDiff(hunkUnified);
      if (!parsed.hunks[0]) {
        void vscode.window.showErrorMessage('无法解析 hunk diff');
        this.post({ type: 'revert_hunk_result', nonce, ok: false, message: '解析失败' });
        return;
      }

      const result = await revertHunk(absPath, parsed.hunks[0]);
      if (result.ok) {
        void vscode.window.showInformationMessage(result.message);
        this.post({ type: 'revert_hunk_result', nonce, ok: true, message: result.message });
      } else {
        void vscode.window.showWarningMessage(result.message);
        this.post({ type: 'revert_hunk_result', nonce, ok: false, message: result.message });
      }
    } catch (e) {
      const err = toAgentError(e);
      void vscode.window.showErrorMessage(`回滚 hunk 失败：${err.toUserMessage()}`);
      this.post({ type: 'revert_hunk_result', nonce, ok: false, message: err.toUserMessage() });
    }
  }

  /**
   * W7b4b · 工具成功执行后推送 unified diff 给 UI。
   * before 在 tool_exec_start 时同步 readFileSync；after 在此处异步读。
   *
   * 优化：
   * - 大文件 Diff 截断：超过 30 个 hunk 的 diff 只推前 30 个到 webview，防止 DOM 卡死
   * - 自动打开编辑器：文件修改后自动在编辑器中打开，并应用内联 hunk 装饰（Accept/Reject）
   * - 完整 diff 只给 InlineDiffController，不推 webview
   */
  private async emitToolDiff(
    toolCallId: string,
    toolName: string,
    pending: {
      relPath: string;
      absPath: string;
      before: string | undefined;
      checkpointPromise: Promise<string | undefined>;
    },
  ): Promise<void> {
    try {
      let after: string | undefined;
      try {
        after = await fs.readFile(pending.absPath, 'utf-8');
      } catch {
        after = undefined; // 文件被删除 / 读失败
      }
      if (pending.before === after) return;

      const created = pending.before === undefined && after !== undefined;
      const deleted = pending.before !== undefined && after === undefined;
      const diff = makeUnifiedDiff(pending.before, after, {
        relPath: pending.relPath,
        ...(created ? { created: true } : {}),
        ...(deleted ? { deleted: true } : {}),
      });
      if (!diff.unified) return;

      const checkpointId = await pending.checkpointPromise.catch(() => undefined);

      // [dbg T-UI2] 即将 post tool_diff
      log.info(
        { toolCallId, relPath: pending.relPath, unifiedLen: diff.unified.length, added: diff.added, removed: diff.removed, hasCheckpoint: !!checkpointId },
        '[dbg T-UI2] emitToolDiff POST tool_diff',
      );

      // 大文件 Diff 截断：webview 只渲染前 30 个 hunk，防止 DOM 卡死
      const truncResult = truncateUnifiedDiff(diff.unified);

      this.post({
        type: 'tool_diff',
        payload: {
          toolCallId,
          toolName,
          relPath: pending.relPath,
          unified: truncResult.unified,
          added: diff.added,
          removed: diff.removed,
          ...(checkpointId ? { checkpointId } : {}),
          ...(created ? { created: true } : {}),
          ...(deleted ? { deleted: true } : {}),
          ...(truncResult.truncated ? { truncated: true, totalHunks: truncResult.totalHunks, shownHunks: truncResult.shownHunks } : {}),
        },
      });

      // Phase 3 · EditorChangeBar 更新（不依赖编辑器/装饰是否成功）
      if (DualMindChatPanel.editorChangeBar && !deleted && diff.added + diff.removed > 0) {
        DualMindChatPanel.editorChangeBar.addChangedFile(
          pending.relPath,
          pending.absPath,
          diff.added,
          diff.removed,
        );
      }

      // Phase 3 · 自动打开文件编辑器 + 应用内联 hunk 装饰
      // 完整 diff（未截断）给编辑器装饰用
      if (DualMindChatPanel.inlineDiffController && diff.unified) {
        try {
          // 自动打开被修改/新建的文件（非 deleted 场景）
          if (!deleted && pending.absPath) {
            const doc = await vscode.workspace.openTextDocument(pending.absPath);
            // 仅在文件尚未打开时打开编辑器（preserveFocus 避免抢焦点）
            const alreadyOpen = vscode.window.visibleTextEditors.some(
              (e) => e.document.uri.fsPath === pending.absPath,
            );
            if (!alreadyOpen) {
              await vscode.window.showTextDocument(doc, {
                preserveFocus: true,
                preview: true,
                viewColumn: vscode.ViewColumn.Beside,
              });
            }
          }
          // await onToolDiff 确保编辑器已 visible 后再应用装饰
          await DualMindChatPanel.inlineDiffController?.onToolDiff(
            pending.absPath,
            pending.relPath,
            diff.unified, // 用完整 diff，不截断
          );
        } catch (e) {
          log.warn({ err: String(e), relPath: pending.relPath }, 'inlineDiff auto-open failed');
        }
      }
    } catch (e) {
      log.warn({ err: String(e), relPath: pending.relPath }, '[dbg T-UI2] emitToolDiff failed');
    }
  }

  /**
   * Phase 3 · 恢复会话时重新生成 diff 数据推送到 webview + inline decorations。
   * 从 checkpoint 系统中提取每个唯一文件的最早 before 内容，
   * 读取当前磁盘文件作为 after，生成 unified diff 并推送。
   */
  private async restoreDiffsForSession(session: { id: string }): Promise<void> {
    // B5 · 防止同一 session 在未被切换走之前被重复恢复
    if (this.restoredDiffKeys.has(session.id)) {
      log.debug({ sessionId: session.id }, '[Phase3] restoreDiffsForSession: already restored, skipping');
      return;
    }
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) return;

      // CheckpointCoordinator 用于验证 checkpoint 系统可用性
      if (!this.getCheckpointCoordinator()) return;

      const store = new CheckpointStore({ workspaceRoot });
      const metas = await store.list(session.id);
      if (!metas || metas.length === 0) return;

      // 收集所有 checkpoint 的完整数据，按 relPath 聚合
      // 保留每个 relPath 的最早 before（第一个 checkpoint 中该文件的快照）
      const fileBeforeMap = new Map<string, string | null>();   // relPath → 最早的 before 内容
      const fileCheckpointMap = new Map<string, string>();       // relPath → 最早的 checkpointId

      for (const meta of metas) {
        const cp = await store.get(meta.id, session.id);
        if (!cp) continue;
        for (const snap of cp.fileSnapshots) {
          if (snap.skipped) continue;
          if (fileBeforeMap.has(snap.relPath)) continue; // 保留最早

          let beforeContent: string | null = null;
          if (snap.wasDeleted) {
            beforeContent = null; // 文件不存在
          } else if (snap.contentHash) {
            // 从内容池读取
            const poolPath = path.join(workspaceRoot, '.devseeker', 'files', snap.contentHash);
            try {
              beforeContent = await fs.readFile(poolPath, 'utf-8');
            } catch {
              beforeContent = null; // 池文件丢失
            }
          }
          fileBeforeMap.set(snap.relPath, beforeContent);
          fileCheckpointMap.set(snap.relPath, meta.id);
        }
      }

      if (fileBeforeMap.size === 0) return;

      // 对每个唯一 relPath 生成 diff 并推送
      let diffIndex = 0;
      for (const [relPath, before] of fileBeforeMap) {
        const absPath = path.join(workspaceRoot, relPath);
        let after: string | undefined;
        try {
          after = await fs.readFile(absPath, 'utf-8');
        } catch {
          after = undefined; // 文件已删除
        }

        // before === after → 无变更，跳过
        if (before === after) continue;

        const created = before === null && after !== undefined;
        const deleted = before !== null && after === undefined;
        const diff = makeUnifiedDiff(before ?? undefined, after, {
          relPath,
          ...(created ? { created: true } : {}),
          ...(deleted ? { deleted: true } : {}),
        });
        if (!diff.unified) continue;

        const checkpointId = fileCheckpointMap.get(relPath);
        diffIndex++;

        log.info(
          { relPath, added: diff.added, removed: diff.removed, checkpointId, restoredIdx: diffIndex },
          '[Phase3] restoreDiffsForSession: re-pushing tool_diff',
        );

        this.post({
          type: 'tool_diff',
          payload: {
            toolCallId: `restore-${session.id}-${diffIndex}`,
            toolName: 'write_file',
            relPath,
            unified: diff.unified,
            added: diff.added,
            removed: diff.removed,
            ...(checkpointId ? { checkpointId } : {}),
            ...(created ? { created: true } : {}),
            ...(deleted ? { deleted: true } : {}),
          },
        });

        // 同时更新 inline decorations（异步避免阻塞 Extension Host）
        if (DualMindChatPanel.inlineDiffController && diff.unified) {
          void Promise.resolve().then(() => {
            DualMindChatPanel.inlineDiffController?.onToolDiff(absPath, relPath, diff.unified);
          });
        }
      }

      log.info(
        { sessionId: session.id, totalFiles: fileBeforeMap.size, restoredDiffs: diffIndex },
        '[Phase3] restoreDiffsForSession: done',
      );
      this.restoredDiffKeys.add(session.id);
    } catch (e) {
      log.warn({ err: String(e), sessionId: session.id }, '[Phase3] restoreDiffsForSession failed');
    }
  }

  dispose(): void {
    DualMindChatPanel.current = undefined;
    this.taskLoop?.abort();
    // W7b4b · 取消所有 pending ask
    this.cancelAllPendingAsk('panel disposed');
    this.cancelAllPendingApprovals('panel disposed');
    this.pendingDiffs.clear();
    // 释放 embedding 子进程
    if (this._embedderCache && 'dispose' in this._embedderCache) {
      try { (this._embedderCache as { dispose(): void }).dispose(); } catch { /* ignore */ }
    }
    // W7b4a: 清理所有后台 session + sweep timer
    try {
      this.terminalManager.dispose();
    } catch {
      /* ignore */
    }
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}

// ─────────── W7b4b · helpers ───────────

/**
 * 从工具 args 解析写入目标（复用 checkpoints/coordinator.ts 的 extractFilePath 语义）。
 * 返回 undefined 表示无法解析（绝对路径 / 路径穿越 / 缺字段等）。
 */
function resolveWriteTarget(
  args: unknown,
  workspaceRoot: string,
): { relPath: string; absPath: string } | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const rec = args as Record<string, unknown>;
  const raw = rec.file_path ?? rec.filePath;
  if (typeof raw !== 'string' || !raw) return undefined;
  const posix = raw.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) return undefined; // 绝对路径
  if (posix.split('/').some((seg) => seg === '..')) return undefined; // 穿越
  const relPath = posix;
  const absPath = path.join(workspaceRoot, relPath);
  return { relPath, absPath };
}

/** 同步读 before 快照；文件不存在 → undefined；超过 2MB → undefined（避免大文件内存占用） */
function readBeforeSync(absPath: string): string | undefined {
  try {
    const stat = fsSync.statSync(absPath);
    if (!stat.isFile()) return undefined;
    if (stat.size > 2 * 1024 * 1024) return undefined;
    return fsSync.readFileSync(absPath, 'utf-8');
  } catch {
    return undefined;
  }
}


// ─────────── Vision by SubAgent · helpers ───────────

/**
 * 从 Message['content'] 中移除所有 image_url 类型的 ContentPart，
 * 返回仅含 text 部分的内容。若全部是图片，返回占位符文本。
 */
function stripImagesFromContent(content: Message['content']): Message['content'] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  const textParts = content.filter(p => p.type !== 'image_url');
  if (textParts.length === 0) {
    return '[用户上传了图片，等待分析...]';
  }
  // 合并相邻的 text part（避免冗余）
  const merged: Array<{ type: 'text'; text: string }> = [];
  for (const p of textParts) {
    if (p.type === 'text') {
      const last = merged[merged.length - 1];
      if (last) {
        last.text += '\n' + p.text;
      } else {
        merged.push({ type: 'text', text: p.text });
      }
    }
  }
  return merged.length === 1 ? merged[0].text : merged;
}

/**
 * 从 messages 数组中移除所有 image_url content parts，
 * 使 LLM 主线程（deepseek）不会收到不支持的内容类型。
 * 图片由 LLM 主动调 Agent(type: "Vision") 子代理处理。
 */
function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(m => {
    if (m.role !== 'user') return m;
    if (typeof m.content === 'string') return m;
    if (!Array.isArray(m.content)) return m;
    const hasImage = m.content.some(p => p.type === 'image_url');
    if (!hasImage) return m;
    return { ...m, content: stripImagesFromContent(m.content) };
  });
}
