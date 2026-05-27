/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 工具层类型
 *
 * 来源：DESIGN §M9.2
 */

import type { ToolSchema } from '../../providers/types.js';

/** 工具安全分级（DESIGN §M9.5） */
export type ToolSafetyLevel =
  | 'read_only' //       read_file / list_dir / grep_code / search_*
  | 'workspace_write' // create_file / search_replace / delete_file
  | 'destructive' //     rm / drop / reset —— 必须 dangerous=true
  | 'network' //         fetch_content / search_web
  | 'external'; //       run_in_terminal / MCP / skill

/**
 * 工具执行上下文。
 * 随 TaskLoop 注入，给工具访问工作区、取消信号、日志等。
 */
import type { FileStateCache } from './file-state-cache.js';

export interface ToolContext {
  /** 工作区根路径（绝对路径）。若未打开工作区则为 undefined */
  workspaceRoot: string | undefined;
  /** 取消信号：工具必须遵守 */
  signal: AbortSignal;
  /** 本轮任务唯一 id */
  taskId: string;
  /** 调用的具体 tool_call_id（来自 LLM） */
  toolCallId: string;
  /** §8.11.2 · 文件变更冲突检测缓存；undefined 时不检测 */
  fileStateCache?: FileStateCache;
  /**
   * 可选的实时输出回调。
   * 工具可在执行期间调用此函数推送中间输出（如 bash 的终端行输出）。
   * 回调的字符串会被累积到 tool_exec_end 的 contentPreview 中，
   * 同时通过 tool_exec_output 事件实时推送到 UI。
   */
  emitOutput?: (output: string) => void;
}

/**
 * 统一工具接口。
 *
 * 契约：
 * - execute 必须是 pure async 函数，不得 throw 非 AgentError 的异常
 * - 超时/取消由外层 ToolRunner 包装，工具实现 respect signal
 * - dangerous=true 的工具必须等待 UI 用户确认（MVP 可走自动拒绝）
 */
export interface ITool<A = Record<string, unknown>, R extends ToolResult = ToolResult> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON Schema
  readonly safetyLevel: ToolSafetyLevel;
  readonly dangerous?: boolean;
  /**
   * 工具级默认执行超时（ms）。
   * 优先级：RunToolOptions.timeoutMs > tool.executionTimeoutMs > DEFAULT_TOOL_TIMEOUT_MS。
   * 用于 Agent / bash / search_web 等默认 30s 不够的长超时工具。
   */
  readonly executionTimeoutMs?: number;

  execute(args: A, ctx: ToolContext): Promise<R>;
}

/**
 * 工具执行结果（序列化形式）。
 * 给 LLM 的最终字符串由 formatForLLM 产出。
 */
export interface ToolResult {
  ok: boolean;
  /** 给 LLM 看的文本内容 */
  content: string;
  /** 可选结构化数据（UI 渲染用，不发回 LLM） */
  display?: Record<string, unknown>;
  /** 错误码（失败时） */
  errorCode?: string;
}

/** 将 ITool 转为 Provider 需要的 ToolSchema */
export function toToolSchema(tool: ITool): ToolSchema {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
