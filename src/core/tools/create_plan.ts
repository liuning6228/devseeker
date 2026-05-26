/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * create_plan 工具（W6b2）
 *
 * 来源：DESIGN §M7.4
 *
 * 语义：
 * - mode='write'：把 Agent 产出的完整 markdown plan 落盘到 <workspaceRoot>/docs/plans/<slug>_<hash>.md
 * - mode='notify_update'：告知"已有 plan 文档被 search_replace 等工具就地编辑"，无需重写
 *
 * 设计决策：
 * - Plan 模式下此工具是写入许可的唯一例外（MODE_META 白名单由 isToolAllowedInMode 放行）
 * - 不依赖任何 vscode API（便于脱离 IDE 单测）；workspace 路径由 deps.getWorkspaceRoot() 注入
 * - 写盘成功后通过 deps.onPlanWritten(absPath) 钩子告知 Panel，
 *   Panel 会把路径记入 ModeManager.setPlanDoc，下一轮 user message 自动注入
 *
 * 文件名规则：
 * - `<slug>_<hash6>.md`，slug 来自 name（限制为 [a-zA-Z0-9_-]，其他字符→下划线，长度裁至 60）
 * - hash6 = SHA-1(name + '\n' + overview).slice(0,6) 保证同名计划可共存
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';

export interface CreatePlanWriteArgs {
  mode: 'write';
  /** 3-4 字英文/数字名称，用于生成文件名 */
  name: string;
  /** 1-2 句摘要 */
  overview: string;
  /** 完整 markdown，首行应为 `# Title` */
  plan: string;
}

export interface CreatePlanNotifyArgs {
  mode: 'notify_update';
  overview: string;
}

export type CreatePlanArgs = CreatePlanWriteArgs | CreatePlanNotifyArgs;

export interface CreatePlanToolDeps {
  /** 返回当前工作区绝对路径；null/undefined 表示未打开 workspace → 工具返回失败 */
  getWorkspaceRoot: () => string | undefined;
  /** 当前已记录的 planDoc（用于 notify_update 校验）；未有则返回 undefined */
  getPlanDoc?: () => string | undefined;
  /** 写盘成功后通知 Panel，由 Panel 更新 ModeManager.planDoc */
  onPlanWritten?: (absPath: string) => Promise<void>;
  /** 重写 plans 目录（默认 'docs/plans'），方便测试 */
  plansDirRel?: string;
}

const parameters = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['write', 'notify_update'] },
    name: { type: 'string', description: "write 时必填；3-4 字短名，如 'Add Login Flow'" },
    overview: { type: 'string', description: '1-2 句摘要；两种 mode 都必填' },
    plan: { type: 'string', description: 'write 时必填；完整 markdown，首行应为 # Title' },
  },
  required: ['mode', 'overview'],
  additionalProperties: false,
} as const;

/** slug 化 name：保留 [a-zA-Z0-9_-]，其他 → 下划线；连续下划线压缩；裁至 60 字符 */
export function slugifyPlanName(name: string): string {
  const base = name
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const sliced = base.slice(0, 60);
  return sliced.length > 0 ? sliced : 'plan';
}

/** 短 hash：SHA-1(name + overview) 前 6 位 */
export function planHash(name: string, overview: string): string {
  return createHash('sha1').update(`${name}\n${overview}`).digest('hex').slice(0, 6);
}

export class CreatePlanTool implements ITool<CreatePlanArgs, ToolResult> {
  readonly name = 'create_plan';
  readonly description =
    'Persist a concise implementation plan to docs/plans/<name>_<hash>.md (mode="write"), or notify the user that an existing plan file has been edited (mode="notify_update"). Use at the END of Plan mode when the user has agreed to the approach.';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  /** 写盘 → workspace_write；Plan 模式通过 PLAN_EXTRA_ALLOW_TOOLS 白名单放行 */
  readonly safetyLevel: ToolSafetyLevel = 'workspace_write';

  constructor(private readonly deps: CreatePlanToolDeps) {}

  async execute(args: CreatePlanArgs, _ctx: ToolContext): Promise<ToolResult> {
    if (!args || (args.mode !== 'write' && args.mode !== 'notify_update')) {
      return {
        ok: false,
        content: 'Error: mode 必须为 "write" 或 "notify_update"',
        errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      };
    }

    if (!args.overview || args.overview.trim().length === 0) {
      return {
        ok: false,
        content: 'Error: overview 不能为空（需 1-2 句描述）',
        errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      };
    }

    if (args.mode === 'notify_update') {
      const existing = this.deps.getPlanDoc?.();
      if (!existing) {
        return {
          ok: false,
          content:
            'Error: notify_update 需要当前已有 plan 文档；请先用 mode="write" 创建后再调用 notify_update。',
          errorCode: ErrorCodes.TOOL_ARGS_INVALID,
        };
      }
      return {
        ok: true,
        content: `已记录 plan 文档更新：${existing}\n摘要：${args.overview}`,
        display: { mode: 'notify_update', planFilePath: existing },
      };
    }

    // ---- mode === 'write' ----
    if (!args.name || args.name.trim().length === 0) {
      return {
        ok: false,
        content: 'Error: write 模式 name 必填（3-4 字短名）',
        errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      };
    }
    if (!args.plan || args.plan.trim().length === 0) {
      return {
        ok: false,
        content: 'Error: write 模式 plan 必填（完整 markdown，首行 # Title）',
        errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      };
    }

    const wsRoot = this.deps.getWorkspaceRoot();
    if (!wsRoot) {
      return {
        ok: false,
        content: 'Error: 未打开 workspace；create_plan 需要一个 workspace 根路径才能写盘。',
        errorCode: ErrorCodes.TOOL_EXEC_FAILED,
      };
    }

    const plansDirRel = this.deps.plansDirRel ?? join('docs', 'plans');
    const plansDirAbs = resolve(wsRoot, plansDirRel);

    // 路径越界防御（尽管 plansDirRel 理论上可信，多一层保险）
    const rel = relative(wsRoot, plansDirAbs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        ok: false,
        content: `Error: plansDirRel 越界（${plansDirRel}）`,
        errorCode: ErrorCodes.TOOL_EXEC_FAILED,
      };
    }

    const slug = slugifyPlanName(args.name);
    const hash = planHash(args.name, args.overview);
    const fileName = `${slug}_${hash}.md`;
    const absPath = resolve(plansDirAbs, fileName);

    // 规范首行：若 plan 未以 # 开头则自动前缀一个 Title
    let body = args.plan;
    if (!/^\s*#\s+/.test(body)) {
      body = `# ${args.name}\n\n${body}`;
    }
    // 始终尾随一个换行
    if (!body.endsWith('\n')) body += '\n';

    try {
      await fs.mkdir(plansDirAbs, { recursive: true });
      await fs.writeFile(absPath, body, 'utf8');
    } catch (e) {
      return {
        ok: false,
        content: `Error: 写入 plan 文件失败 - ${String(e)}`,
        errorCode: ErrorCodes.TOOL_EXEC_FAILED,
      };
    }

    try {
      await this.deps.onPlanWritten?.(absPath);
    } catch {
      // 钩子失败不影响工具返回（已写盘成功）
    }

    const relFromWs = relative(wsRoot, absPath).split(sep).join('/');
    return {
      ok: true,
      content: `Plan 已写入：${relFromWs}\n摘要：${args.overview}\n\n下一步建议：用户批准后切回 Agent 执行，或继续在 Plan 模式完善。`,
      display: { mode: 'write', planFilePath: absPath, planFileRel: relFromWs },
    };
  }
}
