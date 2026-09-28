/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Subagent 类型层（DESIGN §M8.2 / §M8.3）
 *
 * SubagentInvocation 签名与 DESIGN 冻结：
 *   subagent_type / description / prompt / timeout
 *
 * SubagentResult 只把 summary 回写主会话（不塞入子代理的全部消息）。
 *
 * v2.0（Phase 5）扩展：
 * - DelegateTaskArgs：子代理统一入口（替代 Agent 工具）
 * - ToolsetName / TOOLSETS：toolsets 组合引擎
 * - SubagentInvocation 标记 @deprecated，由 DelegateTaskArgs 取代
 */

import type { Message } from '../../providers/types.js';
import { EDIT_TOOL_NAMES } from '../tools/edit-tools.js';

/** 内置子代理 type（常量与类型窄化） */
export type BuiltinSubagentType = 'Browser' | 'Research' | 'Guide' | 'Verify' | 'Vision' | 'RequirementAnalyzer' | 'Debug';

/**
 * 子代理类型放宽为字符串：
 * 内置 5 种 + 用户自定义 agent（来自 `.devseeker/agents/<name>/AGENT.md`）。
 */
export type SubagentType = BuiltinSubagentType | string;

/** 仅内置 type 的枚举（运行时校验 / UI 列表使用） */
export const ALL_BUILTIN_SUBAGENT_TYPES: readonly BuiltinSubagentType[] = [
  'Browser',
  'Research',
  'Guide',
  'Verify',
  'Vision',
  'RequirementAnalyzer',
  'Debug',
] as const;

/** @deprecated 兼容旧名；语义等同 ALL_BUILTIN_SUBAGENT_TYPES */
export const ALL_SUBAGENT_TYPES = ALL_BUILTIN_SUBAGENT_TYPES;

export function isBuiltinSubagentType(t: string): t is BuiltinSubagentType {
  return (ALL_BUILTIN_SUBAGENT_TYPES as readonly string[]).includes(t);
}

/** @deprecated 由 DelegateTaskArgs 取代 */
export interface SubagentInvocation {
  subagent_type: SubagentType;
  description: string;
  prompt: string;
  timeout?: number;
  images?: readonly string[];
}

export interface SubagentResult {
  summary: string;
  stats?: SubagentRunStats;
  artifacts?: string[];
  /**
   * true = 任务未全部完成（当前唯一来源：max_turns 轮次用尽降级回传部分成果）。
   * 调用方（Agent 工具 / UI 卡片）据此区分「完成」与「部分完成」：
   * 母代理可决定直接利用部分成果，或拆分任务后重新派发。
   */
  partial?: boolean;
  /**
   * CVW · 子代理在自己 loop 内编辑成功的文件（绝对路径）。
   *
   * 设计上子代理为**只读**（写工具被 DELEGATE_BLOCKED_TOOLS 硬禁），
   * 本字段正常恒为空。保留作为纵深防御：万一未来出现绕过（自定义 agent /
   * 新增工具未入库），主 loop 仍能把这批写动作并入验证门，不被绕过。
   */
  editedFiles?: readonly string[];
}

export interface SubagentRunStats {
  toolCalls: number;
}

/**
 * 子代理"类型定义"：工具白名单 + SystemPrompt 模板。
 */
export interface SubagentDefinition {
  readonly type: SubagentType;
  readonly allowedTools: ReadonlySet<string>;
  readonly systemPrompt: string;
  readonly maxTurns: number;
  /**
   * 该角色的期望单次执行上限（ms）。缺省回退 runner 的 DEFAULT_TIMEOUT_MS。
   * 不同角色任务形态差异大：Verify/Debug 可能跑长测试，Browser/Vision 很快——
   * 用固定 120s 会把长任务中途杀死（旧 BUG）。
   */
  readonly timeoutMs?: number;
  /**
   * read_file 允许的路径前缀（相对 workspaceRoot）；缺省 = 全工作区。
   * 由 runner 注入到子代理 ToolContext.delegate，在工具层硬执行角色范围。
   */
  readonly readPathPrefixes?: readonly string[];
  /** 网络工具允许的 host 白名单；缺省 = 不限。同样在工具层硬执行。 */
  readonly urlHostWhitelist?: readonly string[];
  readonly description?: string;
  readonly isBuiltin?: boolean;
  readonly filePath?: string;
}

/**
 * 子代理 Registry：内置 + 自定义 agent 合并后的统一解析入口。
 */
export interface SubagentRegistry {
  resolve(type: string): SubagentDefinition | undefined;
  list(): readonly SubagentDefinition[];
}

// ─────────── Phase 5：新接口 ───────────

/** 预定义 toolsets 名称 */
export type ToolsetName =
  | 'search'
  | 'file'
  | 'terminal'
  | 'web'
  | 'plan'
  | 'verify'
  | 'memory'
  | 'review'
  | 'debug'
  | 'all';

/**
 * TOOLSETS 映射：toolset 名 → 白名单工具列表。
 * 与 DESIGN-1.md §4.2 保持一致，对齐当前 subagent definitions。
 */
export const TOOLSETS: Record<ToolsetName, readonly string[]> = {
  search: [
    'search_codebase', 'get_repo_map', 'workspace_symbol', 'document_symbol', 'lsp', 'grep_code',
    'read_file', 'list_dir', 'search_knowledge',
  ],
  file: [
    // 只读文件检查：子代理不写工作区（写工具在 DELEGATE_BLOCKED_TOOLS 硬禁）
    'read_file', 'list_dir', 'grep_code',
  ],
  terminal: ['bash', 'get_terminal_output'],
  web: ['search_web', 'fetch_content', 'read_url'],
  plan: [
    'read_file', 'search_codebase', 'lsp', 'create_plan',
    'grep_code', 'git_log', 'list_dir',
  ],
  verify: [
    'bash', 'get_problems', 'read_file',
    'list_dir', 'search_codebase', 'search_knowledge',
  ],
  memory: ['search_memory', 'update_memory'],
  review: [
    'read_file', 'search_codebase', 'lsp',
    'grep_code', 'get_problems',
  ],
  debug: [
    'read_file', 'trace_error', 'goto_definition',
    'find_references', 'call_hierarchy', 'bash', 'get_terminal_output',
    'get_problems', 'lsp', 'search_codebase', 'grep_code',
  ],
  all: ['*'],
};

/**
 * DELEGATE_BLOCKED_TOOLS：所有子代理中永远不可用的工具（大小写不敏感匹配）。
 * 硬编码不可配置（DESIGN-1.md §4.4 L1 安全）。
 *
 * 子代理的设计定位：**只读调研员 / 验证员**（上下文隔离 + 能力收窄），
 * 一切写工作区的动作与主会话状态变更都由主 Agent 独占（它才持有
 * approval / checkpoint / 验证门）。因此本名单硬禁三类：
 * - 写入类（EDIT_TOOL_NAMES：search_replace / write_file / append_file / delete_file）
 *   —— 直接复用单一事实源，新增编辑工具时自动继承拦截，无需改这里；
 * - 派发类（agent / create_agent / send_message）—— 防递归派生或续跑其他子代理；
 * - 交互 / 主会话状态类（ask_user_question / skill / todo_write / switch_mode）
 *   —— 子代理不与用户交互，也不得篡改主会话的交互模式与任务清单。
 *
 * 注：这里全部小写，实际匹配在 toolset-resolver / runner 里做大小写归一，
 *     因此真实工具名 `Agent`（首字母大写）也能被拦住。
 */
export const DELEGATE_BLOCKED_TOOLS: readonly string[] = [
  ...EDIT_TOOL_NAMES,
  'agent', 'create_agent', 'send_message',
  'ask_user_question', 'skill',
  'todo_write', 'switch_mode',
];

/** Preset 名称（叶子角色快捷方式，全部为只读角色） */
export type PresetName =
  | 'explore'
  | 'planner'
  | 'reviewer'
  | 'verifier'
  | 'general';

/**
 * DelegateTaskArgs —— 子代理统一入口参数
 * 替代旧的 SubagentInvocation。
 */
export interface DelegateTaskArgs {
  goal: string;
  context?: string;

  // 能力控制（二选一或组合）
  preset?: PresetName;
  toolsets?: ToolsetName[];

  // 角色（来自 Hermes）
  role?: 'leaf' | 'orchestrator';

  /**
   * 上下文继承模式。
   * - 'fresh'（默认）：独立上下文，零继承
   * - 'fork'：继承父的 forkContextMessages + cacheSafeParams，共享 prompt cache
   * （'inherit' 已移除：V1 未实现，留着只会被静默降级为 fresh、误导调用方）
   */
  mode?: 'fork' | 'fresh';

  // 三层安全隔离
  isolation?: {
    maxDepth?: number;
    autoApprove?: boolean;
    timeoutSeconds?: number;
    maxChildren?: number;
  };

  // 模型隔离（来自 Hermes）
  model?: string;
  provider?: string;
  apiKey?: string;

  // 执行方式
  parallel?: boolean;
  background?: boolean;
}

export interface DelegateTaskResult {
  summary: string;
  toolCalls: number;
  iterations: number;
  timedOut: boolean;
  artifacts?: string[];
}

/**
 * CacheSafeParams —— Fork 子代理 Cache 共享五维保证。
 *
 * Fork 子代理与父代理共享 prompt cache 需要 API 请求前缀 byte 一致，
 * 任何一维不同都会导致 cache miss。
 *
 * 五维：
 * - systemPrompt：system prompt 文本，含 rendered env details
 * - tools：工具 schema 列表（顺序和内容必须一致）
 * - model：模型名
 * - messages：历史消息前缀（fork 共享父的部分消息）
 * - thinkingConfig：推理配置（budget_tokens 等）
 */
export interface CacheSafeParams {
  /** Rendered system prompt 最终字节 */
  systemPrompt: string;
  /** 工具 schema 列表（序列化为 JSON 后比较） */
  toolSchemasHash: string;
  /** 模型名 */
  model: string;
  /** 父上下文消息快照（fork 子代理复用） */
  forkContextMessages: readonly Message[];
  /** 推理配置摘要（用于 byte 一致性校验） */
  thinkingConfig?: string;
}
