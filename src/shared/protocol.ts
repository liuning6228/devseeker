/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Webview ↔ Extension 双向消息协议（单一真源）
 *
 * 位置：src/shared/ 给 extension host 与 webview-ui 共同引用
 * （webview-ui 通过相对路径 ../../src/shared 引入，不建立跨包 npm 依赖）
 *
 * 约束：
 * - 所有类型必须可 JSON 序列化（穿越 postMessage 边界）
 * - 新增事件必须同步更新 DESIGN §M1.6 / §M11
 * - 修改协议时递增 PROTOCOL_VERSION（扩展端与 webview 版本不匹配时应弹兼容性警告）
 */

/** 协议版本号。主版本变更时，旧版 webview 应提示用户升级扩展。 */
export const PROTOCOL_VERSION = '1.0.0';

/** Step 4: 上下文条目（context_stats.items 中的单个条目） */
export interface ContextItemEntry {
  id: string;
  type: 'file' | 'symbol' | 'memory';
  name: string;
  /** 相对路径（file/symbol）或分类（memory） */
  path: string;
  /** 预估 token 消耗 */
  estimatedTokens: number;
  /** 是否最近引用的 */
  recent?: boolean;
}

/** Step 7: @ 上下文选择器搜索结果条目 */
export interface ContextSearchItem {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'symbol' | 'memory';
  /** 符号类型（仅 type=symbol） */
  kind?: string;
  /** 文件行号（仅 type=symbol） */
  line?: number;
  /** 最近使用时间戳（用于排序） */
  lastUsed?: number;
}

/** Step 22: 记忆条目 */
export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  category: string;
  keywords: string[];
  updatedAt: number;
}

/** Step 12: Skill 命令信息 */
export interface SkillInfo {
  name: string;
  description: string;
  /** 参数模板（如 /commit -m "message"） */
  argsTemplate?: string;
  /** 分类 */
  category: 'workflow' | 'code' | 'review' | 'test' | 'deploy' | 'other';
  /** 使用次数（extension 端统计） */
  usageCount?: number;
}

// ─────────── TaskEvent（TaskLoop → Webview） ───────────

export type TaskEvent =
  | { type: 'task_start'; taskId: string; userInput: string }
  | { type: 'turn_start'; taskId: string; turn: number }
  | { type: 'text_delta'; taskId: string; text: string }
  | { type: 'reasoning_delta'; taskId: string; text: string }
  | { type: 'tool_start'; taskId: string; toolCallId: string; name: string }
  | { type: 'tool_args_delta'; taskId: string; toolCallId: string; partial: string }
  | {
      type: 'tool_exec_start';
      taskId: string;
      toolCallId: string;
      name: string;
      args: unknown;
      /** Step 9: Extension 侧开始执行时间戳，用于精确计时 */
      startTime: number;
    }
  | {
      type: 'tool_exec_output';
      taskId: string;
      toolCallId: string;
      /** 增量输出（仅新增部分，非全量），webview 端自行追加到已有 contentPreview */
      contentPreview: string;
      /** true 表示增量数据，webview 应追加而非替换 */
      isDelta?: boolean;
    }
  | {
      type: 'tool_exec_end';
      taskId: string;
      toolCallId: string;
      name: string;
      ok: boolean;
      contentPreview: string;
      errorCode?: string;
      /** Step 9: Extension 侧结束执行时间戳，用于精确计时 */
      endTime: number;
    }
  | {
      type: 'usage';
      taskId: string;
      promptTokens: number;
      completionTokens: number;
      cachedTokens?: number;
    }
  | {
      type: 'task_end';
      taskId: string;
      reason: 'completed' | 'aborted' | 'error' | 'max_turns';
      errorCode?: string;
      errorMessage?: string;
    }
  /** W8.3 · Context 压缩统计（每次向 LLM 提交前发一次） */
  | {
      type: 'context_stats';
      taskId: string;
      level: 'none' | 'light' | 'medium' | 'heavy';
      originalTokens: number;
      compressedTokens: number;
      savingsPercent: number;
      /** inputBudget = contextWindow - outputReserve */
      inputBudget: number;
      /** Step 4: 上下文中引用的文件/符号/记忆列表（可选） */
      items?: ContextItemEntry[];
    }
  /** Phase 5 Phase D · 后台子代理完成事件 */
  /** Phase 5 Phase D · 后台子代理完成事件 */
  | {
      type: 'subagent_completed';
      taskId: string;
      /** 后台子代理 agentId */
      agentId: string;
      /** 子代理最终摘要 */
      summary: string;
      /** 工具调用次数 */
      toolCalls: number;
      /** 子代理类型（用于 UI 展示） */
      agentType?: string;
      /** 是否失败 */
      failed?: boolean;
    };

// ─────────── Webview → Extension ───────────

export type WebviewInboundMessage =
  | { type: 'ready' }
  | { type: 'send_user_input'; text: string; images?: string[] }
  | { type: 'abort' }
  | { type: 'open_settings' }
  | { type: 'new_session' }
  | { type: 'load_session'; sessionId: string }
  | { type: 'delete_session'; sessionId: string }
  | { type: 'set_preferred_provider'; providerId: string | null }
  | { type: 'set_mode'; mode: 'agent' | 'plan' | 'debug' | 'ask' }
  /** W7b4b · ask_user_question 用户回复 */
  | {
      type: 'ask_question_response';
      requestId: string;
      answers: Array<{ question: string; selected: string[]; other?: string }>;
      cancelled?: boolean;
    }
  /** W7b4b · Revert Step 按钮（回滚到指定 step checkpoint） */
  | { type: 'revert_step'; checkpointId: string }
  /** W15.6 · Hunk 级 Revert（DiffPreview 中单个 hunk 的 Reject 按钮） */
  | {
      type: 'revert_hunk';
      /** 文件绝对路径或相对路径（extension 侧需 resolve） */
      relPath: string;
      /** hunk 的 unified diff 文本（含 @@ 头和行内容） */
      hunkUnified: string;
      /** 标识，回执时带回 */
      nonce: string;
    }
  /** W7c2 · 黄条"立即建索引"按钮 → 触发 devSeeker.reindex 命令 */
  | { type: 'reindex' }
  /** W9.14 · Markdown file:/// 链接点击 → host 打开文件并可选跳行 */
  | {
      type: 'open_file';
      path: string;
      lineStart?: number;
      lineEnd?: number;
    }
  /** W11.4 · 用户点击「打开预览」按钮 → host 调 vscode.env.openExternal */
  | {
      type: 'open_preview';
      url: string;
    }
  /** W-UI5 · 将工具卡中的 bash 命令发送到 VS Code 原生终端（预填不回车） */
  | {
      type: 'open_terminal';
      command: string;
      cwd?: string;
    }
  /** W15.4b · 查询 Inline Edit 历史（webview → extension） */
  | {
      type: 'get_inline_edit_history';
      /** 可选：按文件路径筛选 */
      filePath?: string;
      /** 可选：限制返回条数 */
      limit?: number;
    }
  /** 模型配置：Webview 请求打开配置面板 */
  | { type: 'open_model_config' }
  /** 模型配置：Webview 提交单字段变更（即改即写） */
  | {
      type: 'update_model_config';
      track: 'llm' | 'vllm';
      level: 1 | 2 | 3;
      field: 'provider' | 'apiKey' | 'model' | 'baseUrl' | 'reasoningModel' | 'apiKeys';
      value: string | string[];
    }
  /** W-UI2 · Accept 单文件 diff → 通知 extension 清除 inline diff 装饰 */
  | { type: 'accept_diff'; relPath: string }
  /** W-UI2 · Accept 所有文件 diff → 通知 extension 清除所有 inline diff 装饰 */
  | { type: 'accept_all_diffs' }
  /** W-UI2 · Reject 单文件 diff → 通知 extension 回滚该文件到修改前 */
  | { type: 'reject_diff'; relPath: string; checkpointId?: string }
  /** W-UI2 · Reject 所有文件 diff → 通知 extension 回滚所有文件到修改前 */
  | { type: 'reject_all_diffs'; files: Array<{ relPath: string; checkpointId?: string }> }
  /** 审批响应（Webview → Extension） */
  | { type: 'approval_response'; requestId: string; decision: 'allow_once' | 'remember' | 'deny' | 'redirect_terminal' }
  /** Plan 模式下用户点击"切换到 Agent 执行"按钮 → 切回 Agent + 注入 planDoc */
  | { type: 'switch_to_agent_after_plan' }
  /** 清空所有会话历史 */
  | { type: 'clear_history' }
  /** 记忆管理 */
  | { type: 'open_memory' }
  /** Step 13: 批量删除会话 */
  | { type: 'delete_sessions'; sessionIds: string[] }
  /** Step 13: 更新会话标签 */
  | { type: 'update_session_tags'; sessionId: string; tags: string[] }
  /** Step 7: @ 上下文选择器搜索请求 */
  | { type: 'context_search'; query: string; category: 'file' | 'symbol' | 'memory' | 'all' }
  /** Step 12: 获取 Skill 命令列表 */
  | { type: 'get_skills' }
  /** Step 12: 执行 Skill 命令 */
  | { type: 'execute_skill'; name: string; args?: string }
  /** Step 22: 获取记忆列表 */
  | { type: 'get_memories'; category?: string; query?: string; limit?: number }
  /** Step 22: 删除记忆 */
  | { type: 'delete_memory'; memoryId: string }
  /** Step 22: 创建记忆 */
  | { type: 'create_memory'; title: string; content: string; category: string; keywords: string[] }
  /** 导出当前会话 */
  | { type: 'export_session' }
  /** 检查更新 */
  | { type: 'check_updates' }
  /** 关于 */
  | { type: 'about' };

// ─────────── Todo（W7e4 ·   todo_write 对齐） ───────────

/** 单条待办 */
export interface TodoItem {
  id: string;
  content: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETE' | 'CANCELLED';
}

/** Extension → Webview 推送 todo 列表 */
export interface TodoListPayload {
  todos: TodoItem[];
}

// ─────────── 模型配置 ───────────

/** 单级模型配置（UI 展示用，apiKey 脱敏） */
export interface ModelLevelConfigPayload {
  provider: string;
  model: string;
  apiKeySet: boolean;       // true = 已配置（不传明文 key）
  baseUrl: string;
  reasoningModel: string;
  apiKeysCount: number;     // 备用 Key 数量
}

/** 模型配置推送 payload */
export interface ModelConfigPayload {
  llm: {
    level1: ModelLevelConfigPayload;
    level2?: ModelLevelConfigPayload;
    level3?: ModelLevelConfigPayload;
  };
  vllm: {
    level1: ModelLevelConfigPayload;
    level2?: ModelLevelConfigPayload;
    level3?: ModelLevelConfigPayload;
  };
  /** 可选的 Provider 类型列表（UI 下拉选项） */
  providerTypes: string[];
  /** 每个 Provider 的默认 model 列表（UI 下拉选项） */
  providerDefaults: Record<string, { model: string; reasoningModel?: string; baseUrl: string }>;
  /** 每个 Provider 的可选模型列表（含 free 标注） */
  providerModels: Record<string, Array<{ id: string; label: string; free?: boolean }>>;
  /** 当前生效的 Provider ID（状态指示） */
  activeProviderId?: string;
  activeProviderOk?: boolean;
}

// ─────────── Extension → Webview ───────────

export interface ProviderStatusPayload {
  ok: boolean;
  providerId?: string;
  errorMessage?: string;
  /** 路由候选列表（UI 展示下拉选择，平铺格式兼容旧 UI） */
  availableProviders?: Array<{ id: string; displayName?: string }>;
  /** P1-2: 按双轨分组的 Provider 列表（新版 UI 使用） */
  groupedProviders?: {
    llm: Array<{ id: string; displayName: string; level: number; keyPoolSize: number }>;
    vllm: Array<{ id: string; displayName: string; level: number; keyPoolSize: number }>;
  };
  /** 当前用户偏好（未设置则为 null） */
  preferredProvider?: string | null;
  /** 路由决策原因（debug 展示） */
  routeReason?: string;
}

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
}

/** 成本汇总（Extension → Webview 推送） */
export interface CostSummaryPayload {
  session: {
    CNY: number;
    USD: number;
    promptTokens: number;
    completionTokens: number;
    calls: number;
  };
  total: {
    CNY: number;
    USD: number;
    promptTokens: number;
    completionTokens: number;
    calls: number;
  };
  /** W7b3 今日累计成本（按币种，不含 token 细节） */
  today?: {
    CNY: number;
    USD: number;
  };
  byProvider: Array<{
    providerId: string;
    currency: 'CNY' | 'USD';
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cost: number;
    calls: number;
  }>;
  /** Step 18: 历史费用趋势数据 */
  history?: Array<{ date: string; CNY: number }>;
  /** Step 18: 预算告警文本 */
  budgetAlertMessage?: string;
}

/** 会话清单条目（UI 侧边栏） */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Step 13: 用户自定义标签 */
  tags?: string[];
  /** Step 13: 会话预览（前 100 字符） */
  preview?: string;
}

/** 索引进度（Extension → Webview） */
export interface IndexProgressPayload {
  phase: 'scanning' | 'chunking' | 'embedding' | 'saving' | 'done' | 'idle';
  filesTotal: number;
  filesDone: number;
  chunksTotal: number;
  chunksDone: number;
  message?: string;
}

/** 索引状态快照（Extension → Webview） */
export interface IndexStatusPayload {
  ready: boolean;
  fileCount: number;
  modelId?: string;
  /** W7d2 · 当前工作区绝对路径（用于 ready=false 时黄条展示，帮助用户诊断"扫到 0 files"） */
  workspaceRoot?: string;
  /** W7d3 · 已跑过 reindex 但扫到 0 源码文件 → 黄条改显"此工作区无源码"而非"未索引" */
  scannedButEmpty?: boolean;
  /** Step 19: 索引大小（字节） */
  indexSize?: number;
  /** Step 19: 索引起始时间 */
  startTime?: number;
  /** Step 19: 当前索引状态 */
  status?: 'idle' | 'indexing' | 'completed' | 'error' | 'paused';
  /** Step 19: 当前正在处理的文件 */
  currentFile?: string;
  /** Step 19: 嵌入模型名称 */
  modelName?: string;
  /** Step 19: 向量维度 */
  embeddingDimension?: number;
}

/** Mode 状态（Extension → Webview） */
export interface ModeStatusPayload {
  current: 'agent' | 'plan' | 'debug' | 'ask';
  available: Array<{ id: 'agent' | 'plan' | 'debug' | 'ask'; label: string; description: string }>;
  /** 最近一次 mode 变更原因（例如 switch_mode 批准、用户手动切） */
  lastChangeReason?: string;
  /**
   * Plan 模式下 plan 文档已就绪，等待用户决定是否切回 Agent 执行。
   * true 时 UI 应展示"切换到 Agent 执行"按钮（位于对话头部）。
   * undefined/false 时不展示。
   */
  planReady?: boolean;
  /** Step 6: 模式切换详情（仅自动切换时附带，用于 webview banner 展示） */
  switchDetail?: {
    from: 'agent' | 'plan' | 'debug' | 'ask';
    to: 'agent' | 'plan' | 'debug' | 'ask';
    reason: string;
    suggestion?: string;
  };
}

// ─────────── W7b4b · ask_user_question ───────────

/** 单个 Question（DESIGN §M11.5） */
export interface AskQuestionOption {
  label: string;
  description: string;
}

export interface AskQuestionItem {
  /** 短标签（chip 展示，≤12 字符） */
  header: string;
  /** 完整问题文本 */
  question: string;
  /** 2-4 个选项 */
  options: AskQuestionOption[];
  /** true 多选；缺省单选 */
  multiSelect?: boolean;
}

/** Extension → Webview：发起一次询问 */
export interface AskQuestionPayload {
  /** 由工具生成的请求 id；UI 回填同一 id */
  requestId: string;
  questions: AskQuestionItem[];
}

// ─────────── 审批请求（Extension → Webview 内联卡片） ───────────

/** 审批请求 Payload（Extension → Webview） */
export interface ApprovalRequestPayload {
  requestId: string;
  toolCallId: string;
  toolName: string;
  safetyLevel: string;
  /** 命令风险级别：safe / risky / undefined（非命令工具） */
  riskLevel?: 'safe' | 'risky';
  reason: string;
  command?: string;
  argsPreview: string;
  allowRemember?: boolean;
}

// ─────────── W7b4b · Diff 预览 ───────────

/** 单个文件变更预览（DESIGN §M11.1 Diff 预览） */
export interface ToolDiffPayload {
  /** 对应的 toolCallId（用来把 diff 绑到 ToolCard） */
  toolCallId: string;
  toolName: string;
  /** 相对路径（相对 workspaceRoot） */
  relPath: string;
  /** unified diff 文本（含 `--- before / +++ after / @@ hunks @@`） */
  unified: string;
  /** 新增/删除行数（UI 统计徽标） */
  added: number;
  removed: number;
  /** 关联 step checkpoint id（点 Revert 按钮时回传） */
  checkpointId?: string;
  /** 文件是否新创建 */
  created?: boolean;
  /** 文件是否被删除 */
  deleted?: boolean;
  /** Diff 文本是否因过大被截断（大文件保护） */
  truncated?: boolean;
  /** 截断前的实际 hunk 总数 */
  totalHunks?: number;
  /** 截断后保留的 hunk 数量 */
  shownHunks?: number;
}

export type WebviewOutboundMessage =
  | { type: 'task_event'; event: TaskEvent }
  | { type: 'provider_status'; payload: ProviderStatusPayload }
  | { type: 'history'; messages: HistoryMessage[]; sessionId?: string }
  | { type: 'cost_summary'; payload: CostSummaryPayload }
  | { type: 'session_list'; sessions: SessionSummary[]; currentSessionId?: string }
  | { type: 'reindex_progress'; payload: IndexProgressPayload }
  | { type: 'index_status'; payload: IndexStatusPayload }
  | { type: 'mode_status'; payload: ModeStatusPayload }
  /** W7b4b · 发起 ask_user_question */
  | { type: 'ask_question'; payload: AskQuestionPayload }
  /** 审批请求（Extension → Webview 内联卡片） */
  | { type: 'approval_request'; payload: ApprovalRequestPayload }
  /** W7b4b · 工具写入的 diff 快照（write_file / search_replace） */
  | { type: 'tool_diff'; payload: ToolDiffPayload }
  /** W7b4b · revert 完成回执 */
  | {
      type: 'revert_step_result';
      checkpointId: string;
      ok: boolean;
      message?: string;
    }
  /** W15.6 · hunk revert 完成回执 */
  | {
      type: 'revert_hunk_result';
      nonce: string;
      ok: boolean;
      message?: string;
    }
  /** W7e4 · todo 列表推送 */
  | { type: 'todo_list'; payload: TodoListPayload }
  /** 模型配置推送（Extension → Webview） */
  | { type: 'model_config'; payload: ModelConfigPayload }
  /** W11.4 · run_preview 请求通知 webview 显示「打开预览」按钮 */
  | {
      type: 'preview_request';
      url: string;
      name: string;
      taskId: string;
      toolCallId: string;
    }
  /** W12.1 · 从 extension 侧向 Composer 追加草稿文本（Inline Edit / Cmd+K） */
  | {
      type: 'prefill_input';
      /** 要追加到输入框的文本（末尾会拼接，如已有内容则用空行分隔） */
      text: string;
      /** 每次调用生成的单调 id，用于 webview 判定「这是一次新的 prefill」以避免重复应用 */
      nonce: number;
      /** W15.4 · 标记本次 prefill 来自 Inline Edit，Composer 可据此调整 UI 提示 */
      isInlineEdit?: boolean;
    }
  /** W15.4b · Inline Edit 历史推送（extension → webview，响应 get_inline_edit_history 请求） */
  | {
      type: 'inline_edit_history';
      records: Array<{
        filePath: string;
        startLine: number;
        endLine: number;
        snippetPreview: string;
        userPrompt?: string;
        timestamp: number;
      }>;
    }
  /** Step 7: @ 上下文选择器搜索结果 */
  | { type: 'context_search_result'; query: string; items: ContextSearchItem[] }
  /** Step 12: Skill 命令列表 */
  | { type: 'skill_list'; skills: SkillInfo[] }
  /** Step 22: 记忆列表结果 */
  | { type: 'memory_result'; items: MemoryEntry[] }
  /** Step 22: 记忆已删除 */
  | { type: 'memory_deleted'; memoryId: string };
