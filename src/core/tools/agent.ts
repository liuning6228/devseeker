/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Agent 工具 —— 派生子代理（DESIGN §M8.3 · Phase 5 Phase A Step 3 / Phase D-D1）
 *
 * 双路径兼容：
 * - 旧路径：subagent_type / description / prompt / timeout（行为不变）
 * - 新路径：toolsets / preset / mode / role / isolation / parallel / background / model
 *
 * 安全等级：network（子代理可能访问网络）
 * 反嵌套：子代理的工具白名单严格不包含 `Agent`本身 → 天然防止递归派生。
 */

import type { ITool, ToolContext, ToolResult, ToolSafetyLevel } from './types.js';
import { ErrorCodes } from '../errors/index.js';
import {
  runSubagent,
  type SubagentInvocation,
  type SubagentRegistry,
  type SubagentRunnerDeps,
  type RunSubagentOptions,
} from '../subagent/index.js';
import type { ToolsetName, PresetName } from '../subagent/types.js';
import { resolveToolsets, applyBlockedTools } from '../subagent/toolset-resolver.js';
import { getDefinitionForPreset } from '../subagent/definitions.js';
import { createBuiltinSubagentRegistry } from '../subagent/definitions.js';
import { createSubagentEventBridge } from '../subagent/event-bridge.js';
import type { TaskEvent } from '../../shared/protocol.js';

export interface AgentToolArgs {
  subagent_type: string;
  description: string;
  prompt: string;
  timeout?: number;
  images?: string[];

  /**
   * 可选角色/组合字段（内部与兼容保留）。
   * 注：面向模型的 schema 不再暴露 isolation / parallel / role / provider / apiKey ——
   * 那些旋钮要么无可消费点、要么与“只读子代理”目标冲突（见死参数清理）。
   */
  toolsets?: ToolsetName[];
  preset?: PresetName;
  mode?: 'fork' | 'fresh';
  background?: boolean;
  model?: string;
}

export interface AgentToolDeps {
  getRunnerDeps: () => SubagentRunnerDeps;
  getRegistry?: () => Promise<SubagentRegistry | undefined> | SubagentRegistry | undefined;
}

const parameters = {
  type: 'object',
  properties: {
    subagent_type: {
      type: 'string',
      minLength: 1,
      description:
        'Which subagent to spawn. Built-in (case-insensitive): Browser (pure web), Research (codebase + web), Guide (how to configure DevSeeker), Verify (run tests / type-check / build), Vision (image understanding), Debug (systematic bug diagnosis). Also accepts any custom agent name defined under `.devseeker/agents/<name>/AGENT.md`. Subagents are read-only investigators/verifiers — they never modify the workspace; do all edits in the main agent.',
    },
    description: {
      type: 'string',
      description:
        '3-5 word short description in the user preferred language. Shown in the UI status.',
      minLength: 1,
      maxLength: 64,
    },
    prompt: {
      type: 'string',
      description:
        'Detailed, SELF-CONTAINED task for the subagent. The subagent has a FRESH context and CANNOT see this conversation — do NOT write "investigate the error above"; instead paste every fact, path, and constraint it needs. State explicitly what final summary you expect back.',
      minLength: 1,
    },
    timeout: {
      type: 'number',
      description:
        'Timeout in ms (max 600000). Defaults to the role budget: Verify/Debug 300000, Research 180000, Browser 120000, Guide 90000, Vision 60000; fallback 120000.',
      minimum: 0,
      maximum: 600_000,
    },
    images: {
      type: 'array',
      description: 'Vision SubAgent only: image DataURL strings to be analyzed.',
      items: { type: 'string' },
    },
    // Phase 5 新路径
    mode: {
      type: 'string',
      enum: ['fork', 'fresh'],
      description: 'Context inheritance mode. Default: fresh (fully isolated context).',
    },
    background: {
      type: 'boolean',
      description: 'Run in background. Returns immediately with agent_id.',
    },
    model: {
      type: 'string',
      description: 'Override model name for this subagent.',
    },
  },
  required: ['subagent_type', 'description', 'prompt'],
} as const;

export class AgentTool implements ITool<AgentToolArgs, ToolResult> {
  readonly name = 'Agent';
  readonly description =
    'Spawn a specialized subagent to handle a focused sub-task autonomously. '
    + 'Built-in agents (case-insensitive): Browser (pure web) / Research (codebase + web) / Guide (how to configure DevSeeker) / Verify (run tests / build / type-check) / Vision (image understanding) / Debug (root-cause a bug). '
    + 'Custom agents live under `.devseeker/agents/<name>/AGENT.md`. '
    + 'RESULT CONTRACT: only the subagent\'s final summary returns to you — its internal steps are NOT part of this conversation, so relay the key findings to the user yourself. '
    + 'BUDGET: each subagent has a limited turn budget (Research 40 / Browser 15 / Debug 20 turns). For large investigations, split into 2-3 focused subagents (one subsystem each) instead of one broad task — over-budget subagents return partial results marked partial="true" (relay what they covered and dispatch follow-ups for the rest). '
    + 'DISPATCH POLICY: give each subagent a self-contained prompt; issue independent Agent calls in the SAME turn (they run in parallel) instead of sequentially; never re-do work you delegated. Dispatch Debug only when the user explicitly asks for debugging / root-cause analysis. '
    + 'Subagents are READ-ONLY investigators/verifiers and never modify the workspace — do NOT use for tasks that need direct code modification (edits stay in the main agent, which owns approval / checkpoint / verification).';
  readonly parameters = parameters as unknown as Record<string, unknown>;
  readonly safetyLevel: ToolSafetyLevel = 'network';
  readonly executionTimeoutMs = 600_000;

  constructor(private readonly deps: AgentToolDeps) {}

  async execute(args: AgentToolArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args !== 'object') {
      return { ok: false, content: 'Error: Agent 参数必须为对象', errorCode: ErrorCodes.TOOL_ARGS_INVALID };
    }
    if (typeof args.subagent_type !== 'string' || args.subagent_type.trim().length === 0) {
      return { ok: false, content: 'Error: subagent_type 必须是非空字符串', errorCode: ErrorCodes.TOOL_ARGS_INVALID };
    }
    if (typeof args.description !== 'string' || args.description.trim().length === 0) {
      return { ok: false, content: 'Error: description 不能为空', errorCode: ErrorCodes.TOOL_ARGS_INVALID };
    }
    if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
      return { ok: false, content: 'Error: prompt 不能为空', errorCode: ErrorCodes.TOOL_ARGS_INVALID };
    }

    // ── 双路径判断 ──
    // 新路径承载 background / mode / model 等执行控制字段（schema 已不再暴露 toolsets/preset，
    // 但内部/旧调用仍可传）。仅凭 toolsets/preset 判定会让 background 等字段永久不可达。
    const isNewPath = Array.isArray(args.toolsets)
      || typeof args.preset === 'string'
      || args.background === true
      || typeof args.mode === 'string'
      || typeof args.model === 'string';

    let registry: SubagentRegistry | undefined;
    try {
      registry = await Promise.resolve(this.deps.getRegistry?.());
    } catch {
      registry = undefined;
    }

    if (!isNewPath && registry && !registry.resolve(args.subagent_type)) {
      const avail = registry.list().map((d) => d.type).join(' / ');
      return {
        ok: false,
        content: `Error: subagent_type "${args.subagent_type}" 未注册，可用：${avail}`,
        errorCode: ErrorCodes.SUBAGENT_INVOCATION_INVALID,
      };
    }

    // ── 新路径：完整实现 ──
    if (isNewPath) {
      return this.executeNewPath(args, ctx, registry);
    }

    // ── 旧路径：保持不变 ──
    let registryForRunner: SubagentRegistry | undefined;
    try {
      registryForRunner = await Promise.resolve(this.deps.getRegistry?.());
    } catch {
      registryForRunner = undefined;
    }

    const invocation: SubagentInvocation = {
      subagent_type: args.subagent_type.trim(),
      description: args.description.trim(),
      prompt: args.prompt,
      ...(typeof args.timeout === 'number' ? { timeout: args.timeout } : {}),
      ...(Array.isArray(args.images) && args.images.length > 0 ? { images: args.images } : {}),
    };

    let runnerDeps: SubagentRunnerDeps;
    try {
      runnerDeps = this.deps.getRunnerDeps();
      if (registryForRunner) {
        runnerDeps = { ...runnerDeps, registry: registryForRunner };
      }
    } catch (e) {
      return { ok: false, content: `Error: 无法初始化子代理依赖 - ${String(e)}`, errorCode: ErrorCodes.SUBAGENT_FAILED };
    }

    // UI 事件桥：子代理过程 → 卡片（ctx.emitChildEvent 缺省时整体 no-op）
    // def.maxTurns 作为卡片进度/ETA 的步数预算（registry 缺省时不展示）
    const defBudget = registryForRunner?.resolve(invocation.subagent_type);
    const bridge = createSubagentEventBridge({
      taskId: ctx.taskId,
      parentToolCallId: ctx.toolCallId,
      agentType: invocation.subagent_type,
      description: invocation.description,
      ...(defBudget?.maxTurns ? { maxTurns: defBudget.maxTurns } : {}),
      ...(ctx.emitChildEvent ? { emit: ctx.emitChildEvent } : {}),
    });

    try {
      const result = await runSubagent(runnerDeps, {
        invocation,
        signal: ctx.signal,
        onEvent: bridge.onEvent,
      });
      bridge.end(true, result.summary, result.stats?.toolCalls ?? 0, result.partial);
      return formatSubagentResult(invocation.subagent_type, invocation.description, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      bridge.end(false, msg, 0);
      const code = e instanceof Error && 'code' in e && typeof (e as { code?: unknown }).code === 'string'
        ? (e as { code: string }).code
        : ErrorCodes.SUBAGENT_FAILED;
      return { ok: false, content: `Error: 子代理 ${invocation.subagent_type} 执行失败 - ${msg}`, errorCode: code };
    }
  }

  /**
   * 新路径执行：支持 toolsets/preset/mode/isolation/parallel/background/role。
   * 不再返回占位符，真正调用 runSubagent()。
   */
  private async executeNewPath(
    args: AgentToolArgs,
    ctx: ToolContext,
    registry?: SubagentRegistry,
  ): Promise<ToolResult> {
    // 1. 确定工具白名单 + 可选的 preset 角色 prompt/maxTurns
    let allowedTools: Set<string>;
    let presetSystemPrompt = '';
    let presetMaxTurns = 25;
    if (Array.isArray(args.toolsets) && args.toolsets.length > 0) {
      allowedTools = resolveToolsets(args.toolsets);
    } else if (args.preset) {
      const def = getDefinitionForPreset(args.preset);
      if (def) {
        allowedTools = new Set(def.allowedTools);
        // 保留 preset 自带的角色 prompt 与 maxTurns（旧 BUG：只取 allowedTools，prompt 被丢）
        presetSystemPrompt = def.systemPrompt;
        presetMaxTurns = def.maxTurns;
      } else {
        // general / verifier：getDefinitionForPreset 返回 undefined，用全量通配（除 blocked 外），
        // systemPrompt 由 runner 回退到 buildAgentPrompt。
        allowedTools = new Set<string>(['*']);
      }
    } else {
      // 无组合参数（由 background/mode/model 触发的新路径）→ 按 subagent_type 解析内置/自定义 def，
      // 否则会静默退化成 search 工具集（旧行为会把 Browser 变成检索代理）。
      // 未注入 registry 时回退到内置 registry（与旧路径 runner 的行为一致）。
      const def = (registry ?? createBuiltinSubagentRegistry()).resolve(args.subagent_type);
      if (def) {
        allowedTools = new Set(def.allowedTools);
        presetSystemPrompt = def.systemPrompt;
        presetMaxTurns = def.maxTurns;
      } else {
        // 默认：只读搜索
        allowedTools = resolveToolsets(['search']);
      }
    }

    // 应用 DELEGATE_BLOCKED_TOOLS（通配符展开 + blocked 过滤由 runner.ts 的 toolFilter 统一处理）
    const effectiveTools = allowedTools.has('*')
      ? allowedTools
      : applyBlockedTools(allowedTools);

    // 2. 构建子代理定义（动态，基于 toolsets/preset）
    const agentType = args.preset ?? args.subagent_type;
    const dynamicDef = {
      type: agentType,
      allowedTools: effectiveTools,
      systemPrompt: presetSystemPrompt,
      maxTurns: presetMaxTurns,
      description: args.description,
      isBuiltin: true,
    };

    // 3. 构建 SubagentRunnerDeps（隔离/深度策略由 runner 侧默认值统一承担，
    //    不再从模型参数注入——旧 isolation 旋钮三个字段全是死配置）
    let baseDeps: SubagentRunnerDeps;
    try {
      baseDeps = this.deps.getRunnerDeps();
      if (registry) {
        baseDeps = { ...baseDeps, registry };
      }
      if (args.model) {
        baseDeps = { ...baseDeps, modelOverride: args.model };
      }
    } catch (e) {
      return { ok: false, content: `Error: 无法初始化子代理依赖 - ${String(e)}`, errorCode: ErrorCodes.SUBAGENT_FAILED };
    }

    // 构造 registry 使 runner.ts 能找到动态 def
    const dynamicRegistry: SubagentRegistry = {
      resolve(type: string) {
        if (type === agentType) return dynamicDef;
        return registry?.resolve(type);
      },
      list() {
        return registry?.list() ?? [];
      },
    };

    const invocation: SubagentInvocation = {
      subagent_type: agentType,
      description: args.description,
      prompt: args.prompt,
      ...(typeof args.timeout === 'number' ? { timeout: args.timeout } : {}),
    };

    // context 模式：fork 继承父消息前缀；其余一律 fresh（'inherit' 已移除，避免静默降级）
    const mode: 'fork' | 'fresh' | undefined =
      args.mode === 'fork' ? 'fork' : undefined;
    const isBackground = args.background === true;
    // 并行扇出：由主 loop 在同一轮并行执行多个 Agent 调用实现（Qoder 同型，不设 parallel 旋钮）

    // 6. 构建 RunSubagentOptions（挂上 UI 事件桥：子代理过程 → 卡片）
    const bridge = createSubagentEventBridge({
      taskId: ctx.taskId,
      parentToolCallId: ctx.toolCallId,
      agentType,
      description: args.description,
      maxTurns: presetMaxTurns,
      ...(ctx.emitChildEvent ? { emit: ctx.emitChildEvent } : {}),
    });
    // 事件回调：桥接 UI 卡片；后台子代理完成时把摘要注入主 loop 上下文（结果契约闭环）
    const onEvent = (ev: TaskEvent): void => {
      bridge.onEvent(ev);
      if (isBackground && ev.type === 'subagent_completed') {
        ctx.injectContext?.(formatBackgroundResultNote(ev));
      }
    };
    const runOpts: RunSubagentOptions = {
      invocation,
      signal: ctx.signal,
      mode,
      background: isBackground,
      onEvent,
    };

    const runnerDeps: SubagentRunnerDeps = { ...baseDeps, registry: dynamicRegistry };

    try {
      const result = await runSubagent(runnerDeps, runOpts);
      // 后台模式：卡片终态由 subagent_completed 异步触发（bridge 内部处理），此处不重复上报
      if (!isBackground) {
        bridge.end(true, result.summary, result.stats?.toolCalls ?? 0, result.partial);
      }
      return formatSubagentResult(agentType, args.description, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      bridge.end(false, msg, 0);
      const code = e instanceof Error && 'code' in e && typeof (e as { code?: unknown }).code === 'string'
        ? (e as { code: string }).code
        : ErrorCodes.SUBAGENT_FAILED;
      return { ok: false, content: `Error: 子代理 ${agentType} 执行失败 - ${msg}`, errorCode: code };
    }
  }
}

/**
 * 后台子代理完成回报 → 注入主 loop 下一轮的上下文便签。
 * 这是「结果契约」的闭环：后台结果不能只进 UI 卡片，必须回到主 Agent 上下文。
 */
function formatBackgroundResultNote(ev: Extract<TaskEvent, { type: 'subagent_completed' }>): string {
  const MAX = 4000;
  const summary = ev.summary.length > MAX ? `${ev.summary.slice(0, MAX)}\n...[已截断]` : ev.summary;
  return [
    `<background_subagent_result agent_id="${escapeAttr(ev.agentId)}" type="${escapeAttr(ev.agentType ?? 'unknown')}" failed="${ev.failed === true}" tool_calls="${ev.toolCalls}"${ev.partial ? ' partial="true"' : ''}>`,
    summary,
    '</background_subagent_result>',
    '（这是你先前派发的后台子代理完成后的回报，不是用户的新指令。',
    ev.partial
      ? '注意 partial="true"：子代理达到轮次上限，仅返回部分成果——如需剩余部分请拆分后重新派发。）'
      : '请把它当作背景信息继续当前任务，不要重复派发同一调研。）',
  ].join('\n');
}

function formatSubagentResult(agentType: string, description: string, result: import('../subagent/types.js').SubagentResult): ToolResult {
  const content = [
    `<subagent_result type="${escapeAttr(agentType)}" description="${escapeAttr(description)}"${result.partial ? ' partial="true"' : ''}>`,
    result.summary,
    result.stats ? `\n[stats: ${result.stats.toolCalls} tool calls]` : '',
    `</subagent_result>`,
    '',
    result.partial
      ? '（以上是子代理达到轮次上限后回报的**部分成果**（partial="true"）——任务未全部完成。你可以直接利用已有部分，或把剩余工作拆分为更小的子任务后重新派发。）'
      : '（以上是子代理回报的最终摘要，请基于此继续主任务。）',
  ].join('\n');
  return {
    ok: true,
    content,
    display: {
      subagentType: agentType,
      description,
      summaryPreview: result.summary.slice(0, 200),
      ...(result.partial ? { partial: true } : {}),
      // CVW · 子代理编辑清单：由主 loop 的验证门并入 editedFiles（§4.3 C.5）
      ...(result.editedFiles && result.editedFiles.length > 0
        ? { editedFiles: [...result.editedFiles] }
        : {}),
    },
  };
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
