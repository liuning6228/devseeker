/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ToolRegistry + ToolRunner
 *
 * 来源：DESIGN §M9.2
 *
 * 职责：
 * - 注册并查询工具
 * - 为 LLM 生成 tools schema（传给 Provider）
 * - 执行工具调用，处理：超时 / 取消 / 参数校验 / AgentError 归一化
 */

import type { ITool, ToolContext, ToolResult } from './types.js';
import type { FileStateCache } from './file-state-cache.js';
import { toToolSchema } from './types.js';
import type { ToolSchema } from '../../providers/types.js';
import { AgentError, ErrorCodes, toAgentError } from '../errors/index.js';
import { getLogger } from '../../infra/logger.js';
import type { HookManager, PreToolCallPayload, PostToolCallPayload } from '../hooks/index.js';
import { decideApproval, type ApprovalResult } from './approval-policy.js';
import { classifyCommand } from './safety-classifier.js';
import type { ApprovalAuditSink, ApprovalAuditEntry } from './approval-audit.js';

const log = getLogger('tool.runner');

/** 单次工具执行超时 ms（可按工具覆盖） */
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** 注册表内部存储：args 统一用 any 参数容纳具体 ITool<具体参数类型> */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = ITool<any, ToolResult>;

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (this.tools.has(tool.name)) {
      log.warn({ name: tool.name }, 'Tool re-registered, overriding');
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  list(): AnyTool[] {
    return Array.from(this.tools.values());
  }

  /** 输出给 Provider 的 tools 字段（可选过滤器，典型用于 Mode 白名单） */
  toToolSchemas(filter?: (tool: AnyTool) => boolean): ToolSchema[] {
    const list = filter ? this.list().filter(filter) : this.list();
    return list.map(toToolSchema);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  clear(): void {
    this.tools.clear();
  }
}
export interface RunToolOptions {
  /** 工具唯一标识符 */
  toolCallId: string;
  /** 工具名称 */
  name: string;
  args: Record<string, unknown>;
  /** 来自 TaskLoop 的 workspaceRoot / signal / taskId */
  workspaceRoot: string | undefined;
  signal: AbortSignal;
  taskId: string;
  /** 覆盖默认超时 */
  timeoutMs?: number;
  /** §8.11.2 · 文件变更冲突检测缓存 */
  fileStateCache?: FileStateCache;
  /**
   * 工具执行期间的实时输出回调。
   * 仅在支持流式输出的工具（如 bash）中触发，用于向 UI 推送中间输出。
   */
  onOutput?: (output: string) => void;
}

/**
 * 审批门回调。返回 true 继续执行；返回 false → ToolRunner 返回 TOOL_EXEC_UNSAFE_BLOCKED。
 * v1.8.0 扩展：不再仅限 external，所有 safetyLevel 都会走 decideApproval + 审批门。
 */
export type ToolApprovalGate = (req: {
  tool: ITool<unknown, ToolResult>;
  args: Record<string, unknown>;
  ctx: ToolContext;
  /** 决策原因（来自 decideApproval） */
  reason: string;
  /** 关联的 command（bash 工具特有） */
  command?: string;
  /** 命令风险级别（safe / risky / undefined），UI 据此决定默认按钮 */
  commandSafety?: import('./safety-classifier.js').CommandSafety;
  /** 是否允许"记住本次选择" */
  allowRemember?: boolean;
}) => Promise<{ approved: boolean; remember?: boolean; redirected?: boolean }>;

export interface ToolRunnerOptions {
  hookManager?: HookManager;
  /** 审批门（所有 safetyLevel 触发） */
  approvalGate?: ToolApprovalGate;
  /** 审计日志 sink（v1.8.0） */
  auditSink?: ApprovalAuditSink;
  /** 审批策略覆写（从 .devseeker/approval-policy.yaml 加载） */
  approvalOverrides?: import('./approval-policy-loader.js').ToolOverride[];
  /** 审批策略默认值覆写（从 .devseeker/approval-policy.yaml defaults 加载） */
  approvalPolicyTable?: Partial<import('./approval-policy.js').ApprovalPolicyTable>;
  /**
   * DebugModeGate：在 Debug 模式下拒绝无证修改。
   * 返回 'allow' 或 'block'（附带 blocking 消息）。
   */
  debugModeGate?: (toolName: string) => { verdict: 'allow' | 'block'; message?: string };
}

export class ToolRunner {
  private readonly hookManager?: HookManager;
  private readonly approvalGate?: ToolApprovalGate;
  private readonly auditSink?: ApprovalAuditSink;
  private readonly approvalOverrides?: import('./approval-policy-loader.js').ToolOverride[];
  private readonly approvalPolicyTable?: Partial<import('./approval-policy.js').ApprovalPolicyTable>;
  private readonly debugModeGate?: (toolName: string) => { verdict: 'allow' | 'block'; message?: string };

  constructor(
    private readonly registry: ToolRegistry,
    opts: ToolRunnerOptions = {},
  ) {
    this.hookManager = opts.hookManager;
    this.approvalGate = opts.approvalGate;
    this.auditSink = opts.auditSink;
    this.approvalOverrides = opts.approvalOverrides;
    this.approvalPolicyTable = opts.approvalPolicyTable;
    this.debugModeGate = opts.debugModeGate;
  }

  async run(opts: RunToolOptions): Promise<ToolResult> {
    const tool = this.registry.get(opts.name);
    if (!tool) {
      return {
        ok: false,
        content: `Error: 未知工具 "${opts.name}"`,
        errorCode: ErrorCodes.TOOL_NOT_FOUND,
      };
    }

    const timeoutMs = opts.timeoutMs ?? tool.executionTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const ctx: ToolContext = {
      workspaceRoot: opts.workspaceRoot,
      signal: opts.signal,
      taskId: opts.taskId,
      toolCallId: opts.toolCallId,
      fileStateCache: opts.fileStateCache,
      emitOutput: opts.onOutput,
    };

    // 「终端运行」标记：审批 redirect 时设置，在 tool.execute() 前注入 terminalMode='user_visible'
    let redirectToUserTerminal = false;

    // ─── 审批决策（v1.8.0：所有工具统一走 decideApproval）───
    // 提取 command（仅 bash/终端类工具）
    const command: string | undefined =
      tool.name === 'bash' || tool.name === 'run_in_terminal'
        ? String((opts.args as Record<string, unknown>)?.command ?? '')
        : undefined;
    const approvalResult: ApprovalResult = decideApproval({
      level: tool.safetyLevel,
      // dangerous 是工具级标记（"该工具可执行危险操作"），不应作为 hasRisk 输入。
      // hasRisk 由模型在 tool_call 中显式声明（has_risk=true）或特定工具逻辑决定。
      // v3.2.1 修复：移除 tool.dangerous → hasRisk 的自动映射，
      // 所有 bash 命令走 safety-classifier 分类（safe=auto, risky=confirm, blacklisted=deny）。
      // hasRisk: tool.dangerous ? true : undefined,
      command,
      toolName: tool.name,
      overrides: this.approvalOverrides,
      policy: this.approvalPolicyTable,
    });

    // deny → 硬拒绝（不弹窗）
    if (approvalResult.decision === 'deny') {
      return {
        ok: false,
        content: `Error: 工具 "${tool.name}" 被安全策略拒绝：${approvalResult.reason}`,
        errorCode: ErrorCodes.TOOL_EXEC_UNSAFE_BLOCKED,
      };
    }

    // v3.2.1: bash 工具即使 safe 命令也走审批门，让用户选择"终端运行"或"沙箱运行"。
    // safe 命令的审批面板默认主按钮为「终端运行」，risky 命令默认主按钮为「沙箱运行」。
    const commandSafety = command ? classifyCommand(command) : undefined;
    const isBashTool = tool.name === 'bash' || tool.name === 'run_in_terminal';
    const bashForceApproval = isBashTool && commandSafety === 'safe' && this.approvalGate !== undefined;

    // confirm 或 dangerous 或 bash safe 强制审批 → 走审批门
    const needsApproval = approvalResult.decision === 'confirm' || bashForceApproval;
    if (needsApproval && this.approvalGate) {
      const allowRemember = approvalResult.reason.startsWith('按 ToolSafetyLevel.');
      let approvedResult: { approved: boolean; remember?: boolean; redirected?: boolean };
      try {
        approvedResult = await this.approvalGate({
          tool,
          args: opts.args,
          ctx,
          reason: approvalResult.reason,
          command,
          commandSafety,
          allowRemember,
        });
      } catch (e) {
        log.warn({ tool: tool.name, err: String(e) }, 'approval gate threw; denying');
        return {
          ok: false,
          content: `Error: 审批门异常 - ${String(e)}`,
          errorCode: ErrorCodes.TOOL_EXEC_UNSAFE_BLOCKED,
        };
      }
      if (!approvedResult.approved) {
        return {
          ok: false,
          content: `Error: 工具 "${tool.name}" 被用户拒绝执行（${approvalResult.reason}）`,
          errorCode: ErrorCodes.TOOL_EXEC_UNSAFE_BLOCKED,
        };
      }
      // 用户选择"终端运行"（redirected=true）→ 在用户可见终端中执行命令。
      // 不再绕过 BashTool.execute()，而是注入 terminalMode='user_visible' 后
      // 通过 BashTool 正常执行（走 VscodeTerminalManager.runCommandOnUserTerminal）。
      if (approvedResult.approved && approvedResult.redirected) {
        log.info({ tool: tool.name }, 'tool redirected to user-terminal by user');
        // 退出审批流程，跳转到 tool.execute() —— 但传给 args 的 terminalMode='user_visible'
        // 设标记后继续执行到 tool.execute() 分支。
        redirectToUserTerminal = true;
      }
    }

    // DebugModeGate：debug 模式下编辑前必须已取证
    if (this.debugModeGate) {
      const gateResult = this.debugModeGate(tool.name);
      if (gateResult.verdict === 'block') {
        return {
          ok: false,
          content: `Error: ${gateResult.message}`,
          errorCode: ErrorCodes.TOOL_EXEC_UNSAFE_BLOCKED,
        };
      }
    }

    // Hook: pre_tool_call
    if (this.hookManager) {
      const prePayload: PreToolCallPayload = {
        event: 'pre_tool_call',
        taskId: opts.taskId,
        timestamp: Date.now(),
        toolName: tool.name,
        safetyLevel: tool.safetyLevel,
        toolCallId: opts.toolCallId,
        argsJson: safeStringify(opts.args),
      };
      const outcome = await this.hookManager.emit(prePayload, opts.signal);
      if (outcome.denied) {
        const denier = outcome.denier;
        return {
          ok: false,
          content: `Error: 工具 "${tool.name}" 被 hook ${denier?.spec.name ?? ''} 拦截（exit ${denier?.exitCode ?? '-'}）`,
          errorCode: ErrorCodes.HOOK_DENIED,
        };
      }
    }

    // ─── DebugModeGate：Debug 模式下拒绝无证修改 ───
    if (this.debugModeGate) {
      const gateResult = this.debugModeGate(tool.name);
      if (gateResult.verdict === 'block') {
        return {
          ok: false,
          content: `Error: ${gateResult.message ?? 'Debug 模式要求先取证 (Step 2)'}`,
          errorCode: ErrorCodes.TOOL_EXEC_UNSAFE_BLOCKED,
        };
      }
    }

    const startedAt = Date.now();
    let result: ToolResult;
    // 如果审批选择了「终端运行」，注入 terminalMode='user_visible'
    const execArgs = redirectToUserTerminal && tool.name === 'bash'
      ? { ...(opts.args as Record<string, unknown>), terminalMode: 'user_visible' }
      : opts.args;
    try {
      result = await withTimeout(
        tool.execute(execArgs, ctx),
        timeoutMs,
        `工具 "${tool.name}" 执行超时（${timeoutMs}ms）`,
      );
      log.debug(
        {
          tool: tool.name,
          ok: result.ok,
          durationMs: Date.now() - startedAt,
        },
        'tool executed',
      );
    } catch (e) {
      const err = toAgentError(e, ErrorCodes.TOOL_EXEC_FAILED);
      log.warn(
        { tool: tool.name, code: err.code, durationMs: Date.now() - startedAt },
        'tool execution failed',
      );
      result = {
        ok: false,
        content: `Error: ${err.message}`,
        errorCode: err.code,
      };
    }

    // Hook: post_tool_call（不阻断，异常仅记日志）
    if (this.hookManager) {
      const postPayload: PostToolCallPayload = {
        event: 'post_tool_call',
        taskId: opts.taskId,
        timestamp: Date.now(),
        toolName: tool.name,
        safetyLevel: tool.safetyLevel,
        toolCallId: opts.toolCallId,
        ok: result.ok,
        resultPreview: truncate(result.content ?? '', 2000),
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        durationMs: Date.now() - startedAt,
      };
      try {
        await this.hookManager.emit(postPayload, opts.signal);
      } catch (e) {
        log.warn({ tool: tool.name, err: String(e) }, 'post_tool_call hook failed');
      }
    }

    // 审计日志（v1.8.0）
    if (this.auditSink) {
      const auditEntry: ApprovalAuditEntry = {
        timestamp: new Date().toISOString(),
        toolName: tool.name,
        safetyLevel: tool.safetyLevel,
        decision: needsApproval ? 'confirm' : approvalResult.decision as 'deny' | 'auto',
        approved: result.ok,
        reason: approvalResult.reason,
        argsPreview: truncate(safeStringify(opts.args), 200),
        durationMs: Date.now() - startedAt,
      };
      try {
        await this.auditSink.append(auditEntry);
      } catch (e) {
        log.warn({ tool: tool.name, err: String(e) }, 'audit append failed');
      }
    }

    return result;
  }
}

// ─────────── helpers ───────────

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AgentError({ code: ErrorCodes.TOOL_EXEC_TIMEOUT, message }));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function safeStringify(v: unknown): string {
  try {
    return truncate(JSON.stringify(v) ?? '', 4000);
  } catch {
    return '';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… (truncated, total ${s.length} chars)`;
}

// ApprovalAuditEntry/ApprovalAuditSink 已移至独立的 approval-audit.ts
