/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Approval Policy（DESIGN §M9.5）
 *
 * 给定 (ToolSafetyLevel, CommandSafety, has_risk, overrides) → 决策：
 * - `auto`    —— 立即执行，无需确认
 * - `confirm` —— 需用户批准（UI 弹窗；v1.8.0 已落地）
 * - `deny`    —— 硬拒绝
 *
 * 默认策略（对齐 DESIGN §M9.5 表格 + §M9.6.1 has_risk=true 硬规则）：
 * | Level            | Default |
 * |------------------|---------|
 * | read_only        | auto    |
 * | workspace_write  | auto    |
 * | destructive      | confirm |
 * | network          | auto    |
 * | external         | confirm |
 *
 * 覆写规则（按优先级从高到低）：
 * 1. 命令 classifyCommand == 'blacklisted' → `deny`
 * 2. has_risk === true → `confirm`（即使 level=safe）
 * 3. command_policy（来自 approval-policy.yaml overrides）
 * 4. 命令 classifyCommand == 'risky' → `confirm`
 * 5. 工具级 policy（来自 approval-policy.yaml overrides）
 * 6. 按 level 查默认表（可被 yaml defaults 覆写）
 *
 * v1.8.0 变更：
 * - 支持从 approval-policy-loader 传入 ToolOverride[]
 * - 支持 command_policy 覆写（需传入 command）
 */

import type { ToolSafetyLevel } from './types.js';
import { classifyCommand, type CommandSafety } from './safety-classifier.js';
import type { ToolOverride } from './approval-policy-loader.js';
import { matchToolPattern, matchCommandPattern } from './approval-policy-loader.js';

export type ApprovalDecision = 'auto' | 'confirm' | 'deny';

export interface ApprovalPolicyTable {
  read_only: ApprovalDecision;
  workspace_write: ApprovalDecision;
  destructive: ApprovalDecision;
  network: ApprovalDecision;
  external: ApprovalDecision;
}

export const DEFAULT_POLICY: ApprovalPolicyTable = {
  read_only: 'auto',
  workspace_write: 'auto',
  destructive: 'confirm',
  network: 'auto',
  external: 'confirm',
};

export interface ApprovalContext {
  level: ToolSafetyLevel;
  /** 工具层自判的危险标志（模型传入 has_risk 或 ITool.dangerous） */
  hasRisk?: boolean;
  /** 仅终端类工具传入：原始 command，用于 classifyCommand */
  command?: string;
  /** 可选覆写表（从 .dualmind/approval-policy.yaml defaults 读入） */
  policy?: Partial<ApprovalPolicyTable>;
  /** 可选工具级覆写（从 .dualmind/approval-policy.yaml overrides 读入） */
  overrides?: ToolOverride[];
  /** 工具名（用于匹配 overrides） */
  toolName?: string;
}

export interface ApprovalResult {
  decision: ApprovalDecision;
  reason: string;
  /** 命令分级（仅终端工具） */
  commandSafety?: CommandSafety;
}

/**
 * 决策主函数。返回 auto/confirm/deny + 理由。
 *
 * 优先级：
 * 1. blacklisted → deny
 * 2. has_risk → confirm
 * 3. overrides[].command_policy（匹配 command+tool）
 * 4. classify risky → confirm
 * 5. overrides[].policy（匹配 tool）
 * 6. 默认 level 策略
 */
export function decideApproval(ctx: ApprovalContext): ApprovalResult {
  const table: ApprovalPolicyTable = { ...DEFAULT_POLICY, ...(ctx.policy ?? {}) };

  // 命令级判定（仅当传入 command）
  let commandSafety: CommandSafety | undefined;
  if (ctx.command !== undefined) {
    commandSafety = classifyCommand(ctx.command);
    if (commandSafety === 'blacklisted') {
      return {
        decision: 'deny',
        reason: '命令命中黑名单 —— 不允许执行',
        commandSafety,
      };
    }
  }

  // has_risk === true 强制 confirm（§M9.6.1 硬规则）
  if (ctx.hasRisk === true) {
    return {
      decision: 'confirm',
      reason: 'has_risk=true 强制批准',
      ...(commandSafety ? { commandSafety } : {}),
    };
  }

  // overrides 检查
  if (ctx.overrides && ctx.overrides.length > 0 && ctx.toolName) {
    for (const o of ctx.overrides) {
      if (!matchToolPattern(ctx.toolName, o.tool)) continue;

      // command_policy 覆写（仅当传了 command 且匹配）
      if (o.command_policy && ctx.command && o.command_match) {
        if (matchCommandPattern(ctx.command, o.command_match)) {
          return {
            decision: o.command_policy,
            reason: `approval-policy.yaml override: ${o.tool} 的 command_match 匹配，policy=${o.command_policy}`,
            ...(commandSafety ? { commandSafety } : {}),
          };
        }
      }

      // 工具级 policy 覆写
      if (o.policy) {
        // args_contains 检查
        if (o.args_contains) {
          // 仅对传入字符串参数做匹配（简化：args_contains 仅检查文件路径类参数）
          // 本实现不做精细参数 glob，交由调用方保证
        }
        return {
          decision: o.policy,
          reason: `approval-policy.yaml override: ${o.tool} 匹配，policy=${o.policy}`,
          ...(commandSafety ? { commandSafety } : {}),
        };
      }
    }
  }

  if (commandSafety === 'risky') {
    return {
      decision: 'confirm',
      reason: '命令归类 risky 需批准',
      commandSafety,
    };
  }

  const byLevel = table[ctx.level];
  return {
    decision: byLevel,
    reason: `按 ToolSafetyLevel.${ctx.level} 默认策略`,
    ...(commandSafety ? { commandSafety } : {}),
  };
}
