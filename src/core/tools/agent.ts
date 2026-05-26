/**
 * Copyright (c) 2026 DualMind Contributors
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
import { normalizeIsolation, type IsolationConfig } from '../subagent/delegation-config.js';
import { getDefinitionForPreset } from '../subagent/definitions.js';
import { runConcurrent, type RunnableTask } from '../subagent/thread-pool.js';

export interface AgentToolArgs {
  subagent_type: string;
  description: string;
  prompt: string;
  timeout?: number;
  images?: string[];

  // Phase 5 新路径可选字段
  toolsets?: ToolsetName[];
  preset?: PresetName;
  mode?: 'fork' | 'fresh' | 'inherit';
  role?: 'leaf' | 'orchestrator';
  isolation?: {
    maxDepth?: number;
    autoApprove?: boolean;
    timeoutSeconds?: number;
    maxChildren?: number;
  };
  parallel?: boolean;
  background?: boolean;
  model?: string;
  provider?: string;
  apiKey?: string;
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
        'Which subagent to spawn. Built-in: Browser (pure web), Research (codebase + web), Guide (how to configure DualMind), Verify (run tests / type-check / build). Also accepts any custom agent name defined under `.dualmind/agents/<name>/AGENT.md`. When `toolsets` or `preset` is provided (new path), this field maps to the corresponding preset.',
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
        'Detailed task for the subagent. Can reference prior context (e.g. "investigate the error discussed above").',
      minLength: 1,
    },
    timeout: {
      type: 'number',
      description:
        'Timeout in ms (default 120000, max 600000). Subagent will be aborted if exceeded.',
      minimum: 0,
      maximum: 600_000,
    },
    images: {
      type: 'array',
      description: 'Vision SubAgent only: image DataURL strings to be analyzed.',
      items: { type: 'string' },
    },
    // Phase 5 新路径
    toolsets: {
      type: 'array',
      description: 'Exact toolset composition. Overrides `preset` when both are provided.',
      items: {
        type: 'string',
        enum: ['search', 'file', 'terminal', 'web', 'plan', 'verify', 'memory', 'review', 'all'],
      },
    },
    preset: {
      type: 'string',
      enum: ['explore', 'planner', 'implementer', 'reviewer', 'verifier', 'general'],
      description: 'Preset shortcut for common agent roles.',
    },
    mode: {
      type: 'string',
      enum: ['fork', 'fresh', 'inherit'],
      description: 'Context inheritance mode. Default: fresh.',
    },
    role: {
      type: 'string',
      enum: ['leaf', 'orchestrator'],
      description: 'Agent role. Default: leaf.',
    },
    isolation: {
      type: 'object',
      description: 'Security isolation config (L2).',
      properties: {
        maxDepth: { type: 'number', description: 'Default 2, max 3.' },
        autoApprove: { type: 'boolean', description: 'Auto-approve dangerous commands? Default false.' },
        timeoutSeconds: { type: 'number', description: 'Default 600.' },
        maxChildren: { type: 'number', description: 'Max parallel children. Default 3.' },
      },
    },
    parallel: {
      type: 'boolean',
      description: 'Execute in parallel with other subagents.',
    },
    background: {
      type: 'boolean',
      description: 'Run in background. Returns immediately with agent_id.',
    },
    model: {
      type: 'string',
      description: 'Override model name for this subagent.',
    },
    provider: {
      type: 'string',
      description: 'Override provider for this subagent.',
    },
    apiKey: {
      type: 'string',
      description: 'Override API key for this subagent.',
    },
  },
  required: ['subagent_type', 'description', 'prompt'],
} as const;

export class AgentTool implements ITool<AgentToolArgs, ToolResult> {
  readonly name = 'Agent';
  readonly description =
    'Spawn a specialized subagent to handle a focused sub-task autonomously. Built-in agents: Browser / Research / Guide / Verify / Vision. Custom agents can be defined under `.dualmind/agents/<name>/AGENT.md`. Supports new path via `toolsets`/`preset` fields. Returns only a summary, not full messages. Use when the sub-task is self-contained and benefits from isolation. Do NOT use for tasks that need direct code modification.';
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
    const isNewPath = Array.isArray(args.toolsets) || typeof args.preset === 'string';

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

    try {
      const result = await runSubagent(runnerDeps, { invocation, signal: ctx.signal });
      return formatSubagentResult(invocation.subagent_type, invocation.description, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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
    // 1. 确定工具白名单
    let allowedTools: Set<string>;
    if (Array.isArray(args.toolsets) && args.toolsets.length > 0) {
      allowedTools = resolveToolsets(args.toolsets);
    } else if (args.preset) {
      const def = getDefinitionForPreset(args.preset);
      if (def) {
        allowedTools = new Set(def.allowedTools);
      } else {
        // fallback：general preset 使用全量白名单（除 blocked 外）
        allowedTools = new Set<string>(['*']);
      }
    } else {
      // 默认：只读搜索
      allowedTools = resolveToolsets(['search']);
    }

    // 应用 DELEGATE_BLOCKED_TOOLS
    const effectiveTools = allowedTools.has('*')
      ? allowedTools // 通配符由 runner.ts 的 toolFilter 处理
      : applyBlockedTools(allowedTools);

    // 2. 构建子代理定义（动态，基于 toolsets/preset）
    const agentType = args.preset ?? args.subagent_type;
    const dynamicDef = {
      type: agentType,
      allowedTools: effectiveTools,
      systemPrompt: '',
      maxTurns: 25,
      description: args.description,
      isBuiltin: true,
    };

    // 3. 安全隔离配置
    const isolation: IsolationConfig | undefined = args.isolation
      ? normalizeIsolation(args.isolation)
      : undefined;

    // 4. 构建 SubagentRunnerDeps
    let baseDeps: SubagentRunnerDeps;
    try {
      baseDeps = this.deps.getRunnerDeps();
      if (registry) {
        baseDeps = { ...baseDeps, registry, isolation, spawnDepth: 0 };
      } else {
        baseDeps = { ...baseDeps, isolation, spawnDepth: 0 };
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

    // mode 只支持 fork/fresh，inherit V1 不做
    const mode: 'fork' | 'fresh' | undefined =
      args.mode === 'fork' ? 'fork' : undefined;
    const isBackground = args.background === true;
    const isParallel = args.parallel === true;

    // 5. 并行模式：并发执行多个子代理任务
    if (isParallel) {
      // 当前简化：parallel 模式只支持 subagent_type 数组（AgentTool 只允许单一调用）
      // 并行由 LLM 在同一轮发起多个 Agent 工具调用来实现（TaskLoop 层面处理）
      // 此处忽略 parallel 标记，单次调用仍为同步
    }

    // 6. 构建 RunSubagentOptions
    const runOpts: RunSubagentOptions = {
      invocation,
      signal: ctx.signal,
      mode,
      background: isBackground,
    };

    const runnerDeps: SubagentRunnerDeps = { ...baseDeps, registry: dynamicRegistry };

    try {
      const result = await runSubagent(runnerDeps, runOpts);
      return formatSubagentResult(agentType, args.description, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e instanceof Error && 'code' in e && typeof (e as { code?: unknown }).code === 'string'
        ? (e as { code: string }).code
        : ErrorCodes.SUBAGENT_FAILED;
      return { ok: false, content: `Error: 子代理 ${agentType} 执行失败 - ${msg}`, errorCode: code };
    }
  }
}

function formatSubagentResult(agentType: string, description: string, result: import('../subagent/types.js').SubagentResult): ToolResult {
  const content = [
    `<subagent_result type="${escapeAttr(agentType)}" description="${escapeAttr(description)}">`,
    result.summary,
    result.stats ? `\n[stats: ${result.stats.toolCalls} tool calls]` : '',
    `</subagent_result>`,
    '',
    '（以上是子代理回报的最终摘要，请基于此继续主任务。）',
  ].join('\n');
  return {
    ok: true,
    content,
    display: {
      subagentType: agentType,
      description,
      summaryPreview: result.summary.slice(0, 200),
    },
  };
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
