/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * SendMessageTool —— 子代理间通信工具（Phase 5 Phase D · 方案四 Step 2）
 *
 * 允许主 Agent（或 coordinator）在子代理完成后继续向其发送消息。
 * 子代理恢复执行时复用之前的消息历史。
 *
 * 与 Claude Code 的 SendMessageTool 等价：
 * - `to` 参数匹配子代理的 agentId
 * - 子代理恢复包含之前对话历史的上下文
 *
 * 限制：
 * - 只能向同一 session 内派生过的子代理发送消息
 * - 子代理必须在"完成"状态（尚未清理）或"运行中"状态
 * - 不能发送给已被销毁的子代理
 *
 * DESIGN-1.md §4.8 · ROADMAP.md 方案四 Step 2
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';

export interface SendMessageArgs {
  /** 目标子代理的 agentId */
  to: string;
  /** 要发送的消息内容 */
  message: string;
  /** 可选：5-10 字摘要，用于 UI 展示 */
  summary?: string;
}

export interface SendMessageDeps {
  /** 根据 agentId 查找活跃的子代理 runner，返回 resume 函数 */
  findRunningAgent: (agentId: string) => {
    /** 恢复执行：传入新消息，返回结果 summary */
    resume: (message: string) => Promise<{ summary: string; toolCalls: number }>;
    /** 子代理描述 */
    description: string;
  } | undefined;
  /** 注册一个"可被 SendMessage"的子代理 */
  registerContinuableAgent?: (agentId: string, handler: {
    resume: (message: string) => Promise<{ summary: string; toolCalls: number }>;
    description: string;
  }) => void;
  /** 取消注册（子代理完全结束后调用） */
  unregisterContinuableAgent?: (agentId: string) => void;
}

const parameters = {
  type: 'object',
  properties: {
    to: {
      type: 'string',
      description: '目标子代理的 agentId（来自 Agent 工具返回的 agentId）',
    },
    message: {
      type: 'string',
      description: '要发送给子代理的继续指令（如 "继续调研，现在看具体实现"）',
    },
    summary: {
      type: 'string',
      description: '5-10 字摘要，UI 预览用',
    },
  },
  required: ['to', 'message'],
  additionalProperties: false,
} as const;

export class SendMessageTool implements ITool<SendMessageArgs, ToolResult> {
  readonly name = 'send_message';
  readonly description = 'Send a follow-up message to a running or completed subagent. The subagent resumes with its existing conversation context plus your new message. Use this to continue a subagent instead of spawning a fresh one.';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'network';

  constructor(private readonly deps: SendMessageDeps) {}

  async execute(args: SendMessageArgs, _ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args !== 'object') {
      return { ok: false, content: 'Error: 参数必须为对象', errorCode: ErrorCodes.TOOL_ARGS_INVALID };
    }
    if (typeof args.to !== 'string' || !args.to.trim()) {
      return { ok: false, content: 'Error: to 必须是非空字符串', errorCode: ErrorCodes.TOOL_ARGS_INVALID };
    }
    if (typeof args.message !== 'string' || !args.message.trim()) {
      return { ok: false, content: 'Error: message 不能为空', errorCode: ErrorCodes.TOOL_ARGS_INVALID };
    }

    const agent = this.deps.findRunningAgent(args.to.trim());
    if (!agent) {
      return {
        ok: false,
        content: `Error: 未找到 agentId="${args.to}" 的可继续子代理。可能已超出生命期或被销毁。请检查 agentId 是否正确。`,
        errorCode: ErrorCodes.SUBAGENT_INVOCATION_INVALID,
      };
    }

    try {
      const result = await agent.resume(args.message);
      const content = [
        `<send_message to="${escapeAttr(args.to)}">`,
        result.summary,
        result.toolCalls > 0 ? `\n[tool calls: ${result.toolCalls}]` : '',
        `</send_message>`,
        '',
        '（以上是子代理继续执行后的回报摘要。）',
      ].join('\n');
      return { ok: true, content };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: `Error: 继续子代理 ${args.to} 失败 - ${msg}`, errorCode: ErrorCodes.SUBAGENT_FAILED };
    }
  }
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
