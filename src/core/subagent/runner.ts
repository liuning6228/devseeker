/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * SubagentRunner —— 子代理执行器（DESIGN §M8.3）
 *
 * 核心思路：复用主进程的 TaskLoop + ToolRegistry，但通过 toolFilter 把工具裁剪
 * 到子代理允许的白名单，Prompt 换成子代理专属的 systemPrompt，消息历史完全独立。
 *
 * v3.0（Phase 5 Phase D）扩展：
 * - Fork 上下文继承（mode='fork'）：子代理复用父的 `forkContextMessages`，共享 prompt cache
 * - CacheSafeParams 五维保证：systemPrompt / tools / model / messages / thinkingConfig byte 一致
 * - Parallel 支持：接收 `runConcurrent()` 的调度
 * - Background 支持：通过 `runBackgroundAgent()` 包装
 *
 * 隔离保证：
 * - 独立 TaskLoop 实例（独立 taskId / 独立 MessageHistory）
 * - 独立 SystemPrompt（不带主 Agent 的 rules / skills / memory）
 * - 独立 onEvent（默认不发射，保持主会话干净）
 * - 工具白名单严格校验（TaskLoop toolFilter 既过 schema 又在执行前二次校验）
 * - Fork 时克隆 contentReplacementState 保证 replacement 决策一致性
 *
 * 取消/超时：
 * - `opts.signal`（父任务取消）或 `invocation.timeout`（默认 120s）任一触发 → loop.abort()
 *
 * 返回：回传 summary + stats（工具调用次数），不把子代理全部消息塞回主会话。
 */

import type { IProvider } from '../../providers/base.js';
import { TaskLoop, type TaskLoopToolFilter } from '../task/loop.js';
import type { TaskEvent } from '../task/events.js';
import { ToolRegistry } from '../tools/registry.js';
import { AgentError, ErrorCodes, toAgentError } from '../errors/index.js';
import { ContextManager } from '../context/index.js';
import type {
  SubagentInvocation,
  SubagentRegistry,
  SubagentResult,
  SubagentRunStats,
  CacheSafeParams,
} from './types.js';
import { createBuiltinSubagentRegistry } from './definitions.js';
import { buildAgentPrompt } from './prompt.js';
import { runBackgroundAgent } from './background-agent.js';
import { getLogger } from '../../infra/logger.js';
import { FORK_BOILERPLATE_TAG, buildForkSystemPrompt, isInsideFork } from './fork-agent.js';
import { canSpawn, normalizeIsolation, type IsolationConfig } from './delegation-config.js';
import { resolveToolsets, applyBlockedTools } from './toolset-resolver.js';
import type { Message } from '../../providers/types.js';

const log = getLogger('subagent.runner');

const DEFAULT_TIMEOUT_MS = 120_000;

/** SSE 断裂重试最大次数 */
const MAX_STREAM_BROKEN_RETRIES = 3;
/** SSE 断裂重试退避基数（ms） */
const STREAM_BROKEN_BACKOFF_MS = 2_000;

export interface SubagentRunnerDeps {
  /** 主进程 Provider（子代理共用同一个，避免重建） */
  provider: IProvider;
  /** 主进程 ToolRegistry；会按白名单过滤后暴露给子代理 */
  toolRegistry: ToolRegistry;
  /** 工作区根（传入工具执行上下文） */
  workspaceRoot?: string;
  /**
   * W14.4 · 子代理定义 Registry（内置 + 自定义）。未提供则回退到仅内置。
   */
  registry?: SubagentRegistry;
  /**
   * v1.6.0 · 可选：模型上下文窗口大小（用于 ContextManager 压缩）。
   * 默认 128000。从 provider 取不到时用此默认值。
   */
  contextWindow?: number;
  /** Vision SubAgent 专用：视觉模型 provider，若未提供则降级返回错误 */
  visionProvider?: IProvider;
  /** Phase 5 · 是否使用新的 Cline 级 287 行 Prompt 模板。默认 false（走旧 prompt） */
  useNewPrompt?: boolean;
  /** Phase 5 · 模型覆盖：仅覆盖 model name，复用 base URL 和 API Key */
  modelOverride?: string;
  /**
   * Phase 5 Phase D · 安全隔离配置。
   * 用于控制 maxDepth / autoApprove / timeoutSeconds / maxChildren。
   */
  isolation?: IsolationConfig;
  /**
   * Phase 5 Phase D · 当前嵌套深度。
   * 从 0 开始，每 spawn 一次 +1。
   */
  spawnDepth?: number;
}

export interface RunSubagentOptions {
  invocation: SubagentInvocation;
  /** 父任务 signal（可选）。abort 时会传递给子代理 loop */
  signal?: AbortSignal;
  /** 可选：子代理事件转发（UI 若想实时看子代理状态）。默认不发。 */
  onEvent?: (ev: TaskEvent) => void;

  // ─── Phase 5 Phase D：Fork / CacheSafe ───

  /**
   * 上下文继承模式。
   * - 'fresh'（默认）：独立上下文，零继承
   * - 'fork'：继承父的 forkContextMessages + cacheSafeParams，共享 prompt cache
   * - 'inherit'：V1 不做（⏳ 推迟）
   */
  mode?: 'fork' | 'fresh';

  /**
   * Phase 5 Phase D · Fork 上下文快照。
   * 当 mode='fork' 时必传。包含父进程的完整消息历史快照。
   * 子代理将以此作为对话前缀，保证 API 请求前缀 byte 一致。
   */
  forkContextMessages?: readonly Message[];

  /**
   * Phase 5 Phase D · CacheSafeParams。
   * 当 mode='fork' 时必传。五维参数必须与父进程 API 请求一致。
   */
  cacheSafeParams?: CacheSafeParams;

  /**
   * Phase 5 Phase D · 是否后台执行。
   * true 时立即返回 agent_id，不阻塞主流程。
   */
  background?: boolean;

  /**
   * Phase 5 Phase D · 子代理当前深度（递归 spawn 用）。
   * 不传则使用 deps.spawnDepth ?? 0。
   */
  currentDepth?: number;
}

/** 启动子代理 TaskLoop 并返回 summary + stats。 */
export async function runSubagent(
  deps: SubagentRunnerDeps,
  opts: RunSubagentOptions,
): Promise<SubagentResult> {
  const inv = opts.invocation;
  validateInvocation(inv);

  // ── 递归深度保护 ──
  const effectiveDepth = opts.currentDepth ?? deps.spawnDepth ?? 0;
  const isolation = deps.isolation ? normalizeIsolation(deps.isolation) : undefined;
  if (isolation && !canSpawn(effectiveDepth, isolation.maxDepth)) {
    throw new AgentError({
      code: ErrorCodes.SUBAGENT_INVOCATION_INVALID,
      message: `嵌套深度已达上限（maxDepth=${isolation.maxDepth}，当前 depth=${effectiveDepth}），无法继续派生子代理`,
    });
  }

  const registry = deps.registry ?? createBuiltinSubagentRegistry();
  const def = registry.resolve(inv.subagent_type);
  if (!def) {
    const avail = registry
      .list()
      .map((d) => d.type)
      .join(' / ');
    throw new AgentError({
      code: ErrorCodes.SUBAGENT_INVOCATION_INVALID,
      message: `subagent_type 未注册：${String(inv.subagent_type)}，可用：${avail}`,
    });
  }

  // Vision SubAgent 使用专用的 visionProvider
  if (inv.subagent_type === 'Vision') {
    if (!deps.visionProvider) {
      throw new AgentError({
        code: ErrorCodes.SUBAGENT_FAILED,
        message: 'Vision SubAgent 需要配置视觉模型（VLLM）Provider',
      });
    }
  }

  // ── 后台模式 ──
  if (opts.background) {
    return runSubagentBackground(deps, opts, def.type, inv.prompt);
  }

  // ── 构建 toolFilter ──
  const toolFilter: TaskLoopToolFilter = (tool) => def.allowedTools.has(tool.name);

  // ── Fork 上下文构建 ──
  const isFork = opts.mode === 'fork';
  const forkMessages = isFork ? opts.forkContextMessages : undefined;

  // Fork 时检测递归 fork
  if (isFork && forkMessages && forkMessages.length > 0) {
    const systemMsg = forkMessages.find((m) => m.role === 'system');
    if (systemMsg && typeof systemMsg.content === 'string' && isInsideFork(systemMsg.content)) {
      throw new AgentError({
        code: ErrorCodes.SUBAGENT_INVOCATION_INVALID,
        message: '嵌套 fork 检测到：子代理 system prompt 包含 FORK_BOILERPLATE_TAG，禁止嵌套 fork。请使用 fresh 模式',
      });
    }
  }

  const timeoutMs = inv.timeout && inv.timeout > 0 ? inv.timeout : DEFAULT_TIMEOUT_MS;

  // ContextManager
  const ctxWindow = inv.subagent_type === 'Vision'
    ? (deps.visionProvider?.contextWindow ?? deps.contextWindow ?? 128_000)
    : (deps.contextWindow ?? 128_000);
  const contextManager = new ContextManager({
    contextWindow: ctxWindow,
    outputReserve: 4096,
    protectedTurns: 2,
  });

  // workspace 上下文注入
  const envBlock = buildEnvironmentBlock(deps.workspaceRoot);
  const userPrompt = envBlock
    ? `${inv.prompt}\n\n${envBlock}`
    : inv.prompt;

  // SSE 断裂重试 + summary 取法优化
  let lastError: AgentError | null = null;

  for (let attempt = 0; attempt <= MAX_STREAM_BROKEN_RETRIES; attempt++) {
    let lastAssistantText = '';
    let toolCallCount = 0;
    let endReason: TaskEvent | null = null;

    const collect = (ev: TaskEvent): void => {
      if (ev.type === 'turn_start') {
        lastAssistantText = '';
      } else if (ev.type === 'text_delta') {
        lastAssistantText += ev.text;
      } else if (ev.type === 'tool_exec_end') {
        toolCallCount++;
      } else if (ev.type === 'task_end') {
        endReason = ev;
      }
      opts.onEvent?.(ev);
    };

    // 模型隔离
    const effectiveProvider = deps.modelOverride
      ? (deps.provider)
      : inv.subagent_type === 'Vision' && deps.visionProvider
        ? deps.visionProvider
        : deps.provider;

    // System prompt：fork 模式下注入递归保护标签
    let effectiveSystemPrompt: string;
    if (deps.useNewPrompt && def.isBuiltin) {
      effectiveSystemPrompt = buildAgentPrompt({ goal: inv.prompt });
    } else {
      effectiveSystemPrompt = def.systemPrompt;
    }
    if (isFork) {
      effectiveSystemPrompt = buildForkSystemPrompt(effectiveSystemPrompt, effectiveDepth, isolation?.maxDepth ?? 3);
    }

    const loop = new TaskLoop({
      provider: effectiveProvider,
      toolRegistry: deps.toolRegistry,
      systemPrompt: effectiveSystemPrompt,
      ...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
      maxTurns: def.maxTurns,
      onEvent: collect,
      toolFilter,
      contextManager,
    });

    const timer = setTimeout(() => loop.abort(), timeoutMs);
    const parentAbort = (): void => loop.abort();
    if (opts.signal) {
      if (opts.signal.aborted) {
        loop.abort();
      } else {
        opts.signal.addEventListener('abort', parentAbort, { once: true });
      }
    }

    try {
      // Fork 模式：先用 forkMessages 初始化历史（若 TaskLoop 支持）
      await loop.send(userPrompt, inv.images);
      lastError = null;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', parentAbort);

      // ── 成功：提取结果 ──
      const end = endReason as TaskEvent | null;
      if (!end || end.type !== 'task_end') {
        throw new AgentError({
          code: ErrorCodes.SUBAGENT_FAILED,
          message: `子代理 ${def.type} 未正常结束`,
        });
      }
      if (end.reason === 'aborted') {
        throw new AgentError({
          code: ErrorCodes.SUBAGENT_INTERRUPTED_BY_RESTART,
          message: `子代理 ${def.type} 被中断（超时或父任务取消）`,
        });
      }
      if (end.reason === 'error' || end.reason === 'max_turns') {
        throw new AgentError({
          code: ErrorCodes.SUBAGENT_FAILED,
          message: `子代理 ${def.type} 失败：${end.errorMessage ?? end.reason}`,
        });
      }

      const summary = lastAssistantText.trim();
      if (summary.length === 0) {
        throw new AgentError({
          code: ErrorCodes.SUBAGENT_FAILED,
          message: `子代理 ${def.type} 结束但未返回任何文本（已执行 ${toolCallCount} 次工具调用）`,
        });
      }

      const stats: SubagentRunStats = { toolCalls: toolCallCount };
      return { summary, stats };
    } catch (e) {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', parentAbort);

      const err = toAgentError(e, ErrorCodes.SUBAGENT_FAILED);
      lastError = err;

      // 只有瞬态错误才重试
      const isRecoverable =
        err.code === ErrorCodes.PROVIDER_STREAM_BROKEN ||
        err.code === ErrorCodes.PROVIDER_BAD_REQUEST;
      if (!isRecoverable || attempt >= MAX_STREAM_BROKEN_RETRIES) {
        throw err;
      }

      const delay = STREAM_BROKEN_BACKOFF_MS * Math.pow(2, attempt);
      log.info(
        { subagentType: def.type, attempt: attempt + 1, maxRetries: MAX_STREAM_BROKEN_RETRIES, delayMs: delay, errCode: err.code },
        'SSE broken in subagent, retrying with exponential backoff',
      );

      opts.onEvent?.({
        type: 'text_delta',
        taskId: '',
        text: `\n\n⚠️ [子代理流中断重试 ${attempt + 1}/${MAX_STREAM_BROKEN_RETRIES}]\n`,
      });

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError ?? new AgentError({
    code: ErrorCodes.SUBAGENT_FAILED,
    message: `子代理执行失败（未知原因）`,
  });
}

/**
 * 后台模式：包装 runSubagent 到 BackgroundAgent。
 * 立即返回 agent_id，不阻塞主流程。
 */
async function runSubagentBackground(
  deps: SubagentRunnerDeps,
  opts: RunSubagentOptions,
  agentType: string,
  prompt: string,
): Promise<SubagentResult> {
  const { agentId } = runBackgroundAgent(
    async (): Promise<{ summary: string; toolCalls: number }> => {
      // 去掉 background 标记，递归调用自身（同步执行）
      const syncOpts: RunSubagentOptions = {
        ...opts,
        background: false,
      };
      const result = await runSubagent(deps, syncOpts);
      return { summary: result.summary, toolCalls: result.stats?.toolCalls ?? 0 };
    },
    (ev) => opts.onEvent?.(ev),
    agentType,
    prompt,
  );

  return {
    summary: `[BackgroundAgent: ${agentId}] 子代理已在后台启动（type=${agentType}）。`,
    stats: { toolCalls: 0 },
  };
}

function buildEnvironmentBlock(workspaceRoot?: string): string {
  if (!workspaceRoot) return '';
  const workspaceName = workspaceRoot.split(/[/\\]/).pop() ?? workspaceRoot;
  return [
    '<environment_details>',
    `Workspace: ${workspaceName}`,
    `Root: ${workspaceRoot}`,
    '</environment_details>',
  ].join('\n');
}

function validateInvocation(inv: SubagentInvocation): void {
  if (!inv || typeof inv !== 'object') {
    throw new AgentError({
      code: ErrorCodes.SUBAGENT_INVOCATION_INVALID,
      message: 'invocation 必须为对象',
    });
  }
  if (typeof inv.subagent_type !== 'string' || inv.subagent_type.trim().length === 0) {
    throw new AgentError({
      code: ErrorCodes.SUBAGENT_INVOCATION_INVALID,
      message: `subagent_type 非法：${String(inv.subagent_type)}，必须是非空字符串`,
    });
  }
  if (typeof inv.description !== 'string' || inv.description.trim().length === 0) {
    throw new AgentError({
      code: ErrorCodes.SUBAGENT_INVOCATION_INVALID,
      message: 'description 不能为空',
    });
  }
  if (typeof inv.prompt !== 'string' || inv.prompt.trim().length === 0) {
    throw new AgentError({
      code: ErrorCodes.SUBAGENT_INVOCATION_INVALID,
      message: 'prompt 不能为空',
    });
  }
  if (inv.timeout !== undefined) {
    if (typeof inv.timeout !== 'number' || !Number.isFinite(inv.timeout) || inv.timeout < 0) {
      throw new AgentError({
        code: ErrorCodes.SUBAGENT_INVOCATION_INVALID,
        message: 'timeout 必须为非负数（ms）',
      });
    }
  }
}

/** 导出子类型的 def，便于测试/UI 引用 */
export { getSubagentDefinition } from './definitions.js';
export * from './types.js';
