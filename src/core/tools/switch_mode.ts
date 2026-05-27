/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * switch_mode 工具（W6b1）
 *
 * 来源：DESIGN §M7.5
 *
 * 语义：
 * - Agent 模式发现任务复杂/歧义时，主动请求切到 Plan 模式
 * - Agent 模式遇到 bug 需深入排查时，主动请求切到 Debug 模式
 * - Debug/Plan 模式完成任务后，可切回 Agent 模式继续
 * - **自动批准**（不弹窗，由 Panel 层回调直接执行切换）
 *
 * 设计决策（与 DESIGN §M7.5 一致）：
 * - 切换成功后：ModeManager 更新 current；下一次 send 时按目标模式构建工具白名单
 * - planFileUrl/allowedPrompts 仅 Plan 模式传递，Debug/Agent 模式忽略
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import type { Mode } from '../modes/index.js';
import { ErrorCodes } from '../errors/index.js';

export interface SwitchModeArgs {
  target_mode_id: 'plan' | 'debug' | 'agent';
  explanation?: string;
  /** 关联的 plan 文件路径，审批通过后自动注入 system prompt */
  planFileUrl?: string;
  /** 提前授权的可执行命令列表 */
  allowedPrompts?: string[];
}

const parameters = {
  type: 'object',
  properties: {
    target_mode_id: {
      type: 'string',
      enum: ['plan', 'debug', 'agent'],
      description: '目标模式 ID。plan=先规划后执行，debug=循证排障五步法，agent=全能编码模式。',
    },
    explanation: {
      type: 'string',
      description: '为什么建议切换（展示给用户审批时看），例如 "需要先讨论架构，再动手"。',
    },
    planFileUrl: {
      type: 'string',
      description: '关联的 plan 文件路径，审批通过后自动注入 system prompt。',
    },
    allowedPrompts: {
      type: 'array',
      description: '提前授权的可执行命令列表。',
      items: { type: 'string' },
    },
  },
  required: ['target_mode_id'],
} as const;

/**
 * 审批回调：工具层把审批决策托付给 Panel 层（典型实现走 vscode.window.showInformationMessage modal）。
 *
 * 实现契约：
 * - approved=true：Panel 应已更新 currentMode 为 target，并向 webview 推送 mode_status
 * - approved=false：Panel 保持当前 mode 不变
 * - 抛异常：视为拒绝，不崩溃 TaskLoop
 */
export type SwitchModeApproval = (req: {
  targetMode: Mode;
  explanation: string | undefined;
  taskId: string;
  /** 关联的 plan 文件路径，审批通过后自动注入（可选） */
  planFileUrl?: string;
  /** 提前授权的可执行命令（可选） */
  allowedPrompts?: string[];
}) => Promise<boolean>;

export interface SwitchModeToolDeps {
  /** 返回用户是否批准切换 */
  requestApproval: SwitchModeApproval;
}

export class SwitchModeTool implements ITool<SwitchModeArgs, ToolResult> {
  readonly name = 'switch_mode';
  readonly description =
    'Request switching the agent to another mode (REQUIRES USER APPROVAL). ' +
    'Use target="plan" when the task is large, ambiguous, or has significant trade-offs. ' +
    'Use target="debug" when a bug needs evidence-first troubleshooting. ' +
    'Use target="agent" to return to full-capability coding mode after plan/debug. ' +
    'Do NOT call this for small, clear tasks.';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  /** 不读写文件 / 不执行命令；分类为 read_only 便于审批门放行 */
  readonly safetyLevel: ToolSafetyLevel = 'read_only';

  constructor(private readonly deps: SwitchModeToolDeps) {}

  async execute(args: SwitchModeArgs, ctx: ToolContext): Promise<ToolResult> {
    const target = args?.target_mode_id;
    const allowed = new Set<Mode>(['plan', 'debug', 'agent']);
    if (!allowed.has(target as Mode)) {
      return {
        ok: false,
        content: `Error: target_mode_id 只能为 "plan"、"debug" 或 "agent"。`,
        errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      };
    }

    let approved = false;
    try {
      approved = await this.deps.requestApproval({
        targetMode: target as Mode,
        explanation: args.explanation,
        taskId: ctx.taskId,
      });
    } catch (e) {
      return {
        ok: false,
        content: `Error: 审批请求异常 - ${String(e)}`,
        errorCode: ErrorCodes.TOOL_EXEC_FAILED,
      };
    }

    if (!approved) {
      return {
        ok: true,
        content: `用户拒绝切换到 ${target} 模式，继续当前任务。`,
        display: { approvalRequired: true, approved: false, target },
      };
    }

    // 注意：实际的 mode 切换已在 requestApproval 内部完成（由 Panel 做）。
    // 工具返回确认文本，下轮 system prompt 会反映新 mode。
    return {
      ok: true,
      content: `已切换到 ${target} 模式。后续操作将受 ${target} 模式约束；请根据新模式的能力继续。`,
      display: { approvalRequired: true, approved: true, target },
    };
  }
}
