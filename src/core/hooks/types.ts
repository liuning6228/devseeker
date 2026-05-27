/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Hooks 子系统类型定义（W5 批次 1）
 *
 * 设计参考 Claude Code hooks：用户在 .devseeker/hooks.json 中声明式订阅生命周期事件，
 * 事件触发时执行 shell 命令（stdin 传入 JSON payload）。
 * pre_* 事件可通过命令非零退出码 deny（阻断后续执行）。
 */

export type HookEvent =
  | 'pre_task' // 用户 send → 进入 provider.chat 前
  | 'post_task' // provider 一次 send 全部完成后
  | 'pre_tool_call' // ToolRunner.run 进入 tool.execute 前；支持 deny
  | 'post_tool_call' // tool.execute 返回之后（无论 ok 与否）
  | 'on_error'; // Panel 捕获到顶层错误

/** 工具安全分级（与 core/tools/types 一致） */
export type HookToolSafetyLevel =
  | 'read_only'
  | 'workspace_write'
  | 'destructive'
  | 'network'
  | 'external';

export interface HookMatcher {
  /** 匹配工具名（仅 pre_tool_call / post_tool_call 有效）；支持 '*' 通配 */
  tool?: string;
  /** 匹配工具 safetyLevel */
  safetyLevel?: HookToolSafetyLevel;
}

export interface HookSpec {
  /** 订阅的事件 */
  event: HookEvent;
  /** 可选的匹配器；缺省则匹配所有 */
  match?: HookMatcher;
  /** 要执行的 shell 命令（通过当前 shell 解释） */
  command: string;
  /** 命令工作目录；相对路径基于 workspaceRoot；缺省 = workspaceRoot */
  cwd?: string;
  /** 执行超时 ms；缺省 15000 */
  timeoutMs?: number;
  /**
   * 是否可 deny 流程（仅 pre_* 有效）。
   * 当 command 以非零退出码结束时：
   *  - deny=true  → 阻断后续执行（ToolRunner 返回 HOOK_DENIED）
   *  - deny=false → 仅记日志，不阻断
   * 缺省 pre_* = true，post_* = false。
   */
  deny?: boolean;
  /** 可选标签，便于日志追踪 */
  name?: string;
}

export interface HookConfig {
  hooks: HookSpec[];
}

// ─────────── payloads ───────────

export interface HookPayloadBase {
  event: HookEvent;
  taskId: string;
  timestamp: number;
}

export interface PreTaskPayload extends HookPayloadBase {
  event: 'pre_task';
  /** 本轮用户输入（截断后） */
  userInput: string;
}

export interface PostTaskPayload extends HookPayloadBase {
  event: 'post_task';
  /** 本轮产生的工具调用数 */
  toolCalls: number;
  /** 最终 assistant 文本（截断后） */
  assistantText: string;
  /** 是否成功 */
  ok: boolean;
}

export interface PreToolCallPayload extends HookPayloadBase {
  event: 'pre_tool_call';
  toolName: string;
  safetyLevel: HookToolSafetyLevel;
  toolCallId: string;
  /** 工具参数 JSON 字符串（已截断） */
  argsJson: string;
}

export interface PostToolCallPayload extends HookPayloadBase {
  event: 'post_tool_call';
  toolName: string;
  safetyLevel: HookToolSafetyLevel;
  toolCallId: string;
  ok: boolean;
  /** 工具返回 content（截断后） */
  resultPreview: string;
  errorCode?: string;
  durationMs: number;
}

export interface OnErrorPayload extends HookPayloadBase {
  event: 'on_error';
  errorCode: string;
  message: string;
}

export type HookPayload =
  | PreTaskPayload
  | PostTaskPayload
  | PreToolCallPayload
  | PostToolCallPayload
  | OnErrorPayload;

// ─────────── execution result ───────────

export interface HookRunResult {
  spec: HookSpec;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** 命令是否被本端超时 kill */
  timedOut: boolean;
}

export interface EmitOutcome {
  results: HookRunResult[];
  /** 若任一 deny hook 非零退出且 deny=true，则 denied=true，附带首个 denier */
  denied: boolean;
  denier?: HookRunResult;
}
