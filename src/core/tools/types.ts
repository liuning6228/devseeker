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
   * 交互类工具标记：该工具的执行本身就是「向用户征询」（弹出交互卡片并等待回答）。
   *
   * 语义有两条，都源自「这段耗时属于人类而不属于机器」：
   *
   * 1. **永不进入审批门**。对「向用户提问」再叠加一次「是否允许提问」的审批是
   *    范畴错误——审批门的职责是让用户对 AI 的行为把关，而交互类工具的执行就是
   *    把关本身。叠加的后果是双重弹窗：用户先看到一个只有工具名 + JSON 参数预览的
   *    技术审批卡，既没有选项也没有输入框，很容易误点「拒绝」，此后真正的交互卡片
   *    永远不会出现，LLM 只能收到一条「被用户拒绝」然后自行猜测。
   *    注意：本标记只豁免 confirm 审批，不豁免 deny（安全策略硬拒绝仍然生效）。
   *
   * 2. **不设执行超时**（除调用方显式传入 RunToolOptions.timeoutMs）。用挂钟给人类
   *    思考计时是错的，而 ToolRunner 的 withTimeout 只是 race：超时后底层 Promise
   *    仍在跑、弹窗仍在 UI 上，用户随后提交的答案会 resolve 一个已被丢弃的 Promise，
   *    答案静默丢失且 LLM 已经带着「执行超时」往下走了。中止由 ctx.signal 负责。
   *
   * 实现交互类工具时必须保证：bridge 与 ctx.signal 竞速，signal abort 后能立即返回。
   */
  readonly interactive?: boolean;
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
