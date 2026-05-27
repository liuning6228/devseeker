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

/** 内置子代理 type（常量与类型窄化） */
export type BuiltinSubagentType = 'Browser' | 'Research' | 'Guide' | 'Verify' | 'Vision';

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
  | 'all';

/**
 * TOOLSETS 映射：toolset 名 → 白名单工具列表。
 * 与 DESIGN-1.md §4.2 保持一致，对齐当前 subagent definitions。
 */
export const TOOLSETS: Record<ToolsetName, readonly string[]> = {
  search: [
    'search_codebase', 'search_symbol', 'lsp', 'grep_code',
    'read_file', 'list_dir', 'search_knowledge',
  ],
  file: [
    'read_file', 'search_replace', 'write_file', 'append_file', 'delete_file',
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
  all: ['*'],
};

/**
 * DELEGATE_BLOCKED_TOOLS：所有子代理中永远不可用的工具。
 * 硬编码不可配置（DESIGN-1.md §4.4 L1 安全）
 */
export const DELEGATE_BLOCKED_TOOLS: readonly string[] = [
  'agent', 'create_agent', 'delegate_task', 'ask_user_question', 'skill',
];

/** Preset 名称（叶子角色快捷方式） */
export type PresetName =
  | 'explore'
  | 'planner'
  | 'implementer'
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

  // 上下文模式（三层，Cline fork 增强）
  mode?: 'fork' | 'fresh' | 'inherit';

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
