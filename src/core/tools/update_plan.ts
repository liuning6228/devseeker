/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * update_plan 工具（Phase 5 Phase A Step 3）
 *
 * 职责：接受 `planId + stepNumber + status`，更新 plan 文件的 frontmatter `status`。
 * 写前 re-read + 解析 frontmatter 再写回，避免内存缓存覆盖。
 *
 * Plan mode 写权限通过 `PLAN_EXTRA_ALLOW_TOOLS` 放行。
 *
 * DESIGN-1.md §4.1 · ROADMAP.md 方案二 Phase A Step 3
 */

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';

const PLAN_DIR_REL = 'docs/plans';

export interface UpdatePlanArgs {
  /** Plan id（文件名不含扩展名，如 "plan_auth_1a2b3c"） */
  planId: string;
  /** 步骤序号（从 1 开始） */
  stepNumber: number;
  /** 新状态 */
  status: 'pending' | 'done' | 'skipped';
}

export interface UpdatePlanToolDeps {
  getWorkspaceRoot: () => string | undefined;
}

const parameters = {
  type: 'object',
  properties: {
    planId: {
      type: 'string',
      minLength: 1,
      description: 'Plan id (filename without extension, e.g. "plan_auth_1a2b3c").',
    },
    stepNumber: {
      type: 'integer',
      minimum: 1,
      description: 'Step number (1-based).',
    },
    status: {
      type: 'string',
      enum: ['pending', 'done', 'skipped'],
      description: 'New status for the step.',
    },
  },
  required: ['planId', 'stepNumber', 'status'],
  additionalProperties: false,
} as const;

export class UpdatePlanTool implements ITool<UpdatePlanArgs, ToolResult> {
  readonly name = 'update_plan';
  readonly description =
    'Update a plan step status in the plan file. Re-reads the file before writing to avoid overwriting concurrent edits. Plan mode: allowed via PLAN_EXTRA_ALLOW_TOOLS.';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'workspace_write';

  constructor(private readonly deps: UpdatePlanToolDeps) {}

  async execute(args: UpdatePlanArgs, _ctx: ToolContext): Promise<ToolResult> {
    if (!args || !args.planId || !args.status) {
      return { ok: false, content: 'Error: planId 和 status 不能为空', errorCode: ErrorCodes.TOOL_ARGS_INVALID };
    }

    const wsRoot = this.deps.getWorkspaceRoot();
    if (!wsRoot) {
      return { ok: false, content: 'Error: 未打开 workspace', errorCode: ErrorCodes.TOOL_EXEC_FAILED };
    }

    const planFilePath = resolve(wsRoot, PLAN_DIR_REL, `${args.planId}.md`);
    if (!planFilePath.startsWith(resolve(wsRoot))) {
      return { ok: false, content: 'Error: planId 路径越界', errorCode: ErrorCodes.TOOL_EXEC_FAILED };
    }

    let content: string;
    try {
      content = await fs.readFile(planFilePath, 'utf-8');
    } catch {
      return { ok: false, content: `Error: plan 文件 ${args.planId}.md 不存在`, errorCode: ErrorCodes.TOOL_EXEC_FAILED };
    }

    // frontmatter 格式：---\nkey: value\nstep1: pending\nstep2: pending\n---\nbody...
    // 替换 step<number>: <old_status> → step<number>: <new_status>
    const stepKey = `step${args.stepNumber}`;
    const stepPattern = new RegExp(`^(${stepKey}\\s*:\\s*)\\w+$`, 'gm');
    if (!stepPattern.test(content)) {
      // 重置 lastIndex
      stepPattern.lastIndex = 0;
      const found = stepPattern.exec(content);
      if (!found) {
        return {
          ok: false,
          content: `Error: plan 文件中未找到 ${stepKey} 字段`,
          errorCode: ErrorCodes.TOOL_ARGS_INVALID,
        };
      }
    }

    // 重新 test 后 lastIndex 已移动，用 replace
    stepPattern.lastIndex = 0;
    const updated = content.replace(stepPattern, `$1${args.status}`);

    if (updated === content) {
      return { ok: true, content: `${stepKey} 已经是 ${args.status}，无需更新` };
    }

    try {
      await fs.writeFile(planFilePath, updated, 'utf-8');
      return { ok: true, content: `✅ ${stepKey} → ${args.status}` };
    } catch (e) {
      return {
        ok: false,
        content: `Error: 更新 plan 文件失败 - ${(e as Error).message}`,
        errorCode: ErrorCodes.TOOL_EXEC_FAILED,
      };
    }
  }
}
