/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * TaskLoop —— 单会话对话循环
 *
 * 来源：DESIGN §1.2 架构图 "Task Loop: prompt→LLM→tool→repeat"
 *
 * 职责：
 * 1. 维护消息历史（MessageHistory）
 * 2. 驱动 Provider.createMessage 流式拉取响应
 * 3. 识别工具调用 → 调用 ToolRunner → 把 tool 结果塞回历史
 * 4. 循环直到 stop/length 或 max_turns
 * 5. 对外发射 TaskEvent 给 UI
 *
 * MVP 不做：
 * - Mode 调度（M7）、子代理（M8）、Router（M2）
 * - Checkpoint / Rollback（M15）
 * - Skills / Rules 动态加载（M9.3 / M13）
 */

import { randomUUID } from 'node:crypto';
import type { IProvider } from '../../providers/base.js';
import type { StreamEvent, ToolCall, Message } from '../../providers/types.js';
import { ToolRegistry, ToolRunner, type ToolApprovalGate } from '../tools/registry.js';
import { isEvidenceTool } from '../tools/debug-mode-gate.js';
import type { ApprovalAuditSink } from '../tools/approval-audit.js';
import type { ITool, ToolResult } from '../tools/types.js';
import { MessageHistory } from './history.js';
import type { TaskEvent } from './events.js';
import { AgentError, ErrorCodes, toAgentError } from '../errors/index.js';
import { ContextManager } from '../context/index.js';
import {
  HealingTracker,
  tryHeal as tryHealTool,
} from '../self-healing/tool-healing.js';
import { DynamicPromptModifier } from '../self-healing/dynamic-prompt-modifier.js';
import { FileStateCache } from '../tools/file-state-cache.js';
import type {
  HookManager,
  PreTaskPayload,
  PostTaskPayload,
  OnErrorPayload,
} from '../hooks/index.js';
import { getLogger } from '../../infra/logger.js';
import { StreamingFileWriter } from '../tools/streaming-file-writer.js';
import { StreamingDiffViewProvider } from '../../ui/streaming-diff-view.js';

const log = getLogger('task.loop');

/**
 * 截断 argsRaw 中大字段，防止历史消息内存爆炸。
 * 方案 B：对 write_file/append_file 的 content 等大 payload，直接整个移除，
 * 只保留 _truncated 标记。content 已由 StreamingFileWriter 写入临时文件，
 * LLM 不需要在历史中看到自己的输出内容。
 *
 * 对其他工具（bash.command、search_replace.new_string 等），保留前 5_000 字符
 * 作为参考（这些没有 StreamingFileWriter 兜底）。
 */
function truncateArgsRawForHistory(argsRaw: string, toolName: string): string {
  if (argsRaw.length < 10_000) return argsRaw;
  try {
    const parsed = JSON.parse(argsRaw) as Record<string, unknown>;
    const REMOVE_KEYS: string[] = [];
    const TRUNCATE_KEYS: string[] = [];
    if (toolName === 'write_file' || toolName === 'append_file') {
      // 方案 B：完全移除 content（StreamingFileWriter 已写入临时文件）
      REMOVE_KEYS.push('content');
    } else if (toolName === 'create_file') {
      REMOVE_KEYS.push('file_content');
    } else if (toolName === 'search_replace') {
      TRUNCATE_KEYS.push('new_string', 'old_string');
    } else if (toolName === 'bash') {
      TRUNCATE_KEYS.push('command');
    }
    let truncated = false;
    for (const key of REMOVE_KEYS) {
      const val = parsed[key];
      if (typeof val === 'string' && val.length > 5_000) {
        delete parsed[key];
        truncated = true;
      }
    }
    for (const key of TRUNCATE_KEYS) {
      const val = parsed[key];
      if (typeof val === 'string' && val.length > 5_000) {
        parsed[key] = val.slice(0, 5_000) + '\n…[截断，原始 ' + val.length + ' 字符]';
        truncated = true;
      }
    }
    if (truncated) {
      (parsed as Record<string, unknown>)._truncated = true;
    }
    return JSON.stringify(parsed);
  } catch {
    // 非法 JSON，原样返回
    return argsRaw;
  }
}

/**
 * 默认最大轮次 —— 防死循环（DESIGN §error-model TASK_LOOP_INFINITE）
 *
 * rc.4 调整为 150：
 * - rc.3 的 25 在真实长任务（跨 44+ 文件重构、批量接口改写）中已被观测到 hard-stop
 *   （见 .dualmind/g2-evidence/T4/reply.md：Batch 2/5 截断），与业界参考值
 *   （Claude Code ~200 / Cursor ~100）存在 4–8× 差距。
 * - 150 为平衡值：留足完成中型重构，又不至于在真正失控时浪费过多 token。
 * - 用户可经 VS Code Settings · dualMind.maxTurns 覆盖（范围 25–500）。
 */
const DEFAULT_MAX_TURNS = 150;

/** 工具过滤器（Mode 白名单专用）。返回 true 表示该工具在当前上下文可用。 */
export type TaskLoopToolFilter = (
  tool: Pick<ITool<unknown, ToolResult>, 'name' | 'safetyLevel'>,
) => boolean;

export interface TaskLoopConfig {
  provider: IProvider;
  toolRegistry: ToolRegistry;
  systemPrompt: string;
  /** 可选：工作区根路径（工具执行需要） */
  workspaceRoot?: string;
  /** 可选：最大循环次数，默认 150（rc.4 从 25 提升） */
  maxTurns?: number;
  /** 可选：外部发射事件（UI 消费） */
  onEvent?: (event: TaskEvent) => void;
  /** 可选：恢复历史（session 加载时用） */
  initialMessages?: Message[];
  /** 可选：Hook 管理器（W5） */
  hookManager?: HookManager;
  /** 可选：工具审批门（所有 safetyLevel 触发） */
  approvalGate?: ToolApprovalGate;
  /** 可选：审批审计日志 sink */
  auditSink?: ApprovalAuditSink;
  /** 可选：审批策略覆写（从 .dualmind/approval-policy.yaml 加载） */
  approvalOverrides?: import('../tools/approval-policy-loader.js').ToolOverride[];
  /** 可选：审批策略默认值覆写（从 .dualmind/approval-policy.yaml defaults 加载） */
  approvalPolicyTable?: Partial<import('../tools/approval-policy.js').ApprovalPolicyTable>;
  /**
   * 可选：工具白名单过滤器（W6b1 Mode 调度）
   * - 用于按当前 Mode（Plan/Ask）只暴露只读工具给 LLM
   * - 执行时二次校验：LLM 若调了非白名单工具，直接返回拒绝结果（不走到 tool.execute）
   */
  toolFilter?: TaskLoopToolFilter;
  /** 可选：Context 管理器（W8）；不传则不压缩 */
  contextManager?: ContextManager;
  /**
   * 可选：本次 TaskLoop 生命周期内所有轮次强制走指定模型 id（W15.5 Auto-Thinking-Router）。
   * 典型用法：panel 侧探测到需 reasoning → 传 deepseek-reasoner，
   * Provider.createMessage 收到后通过 options.modelOverride 切模型。
   * 未传则走 Provider 的默认 model。
   */
  modelOverride?: string;
  /**
   * 可选：CodebaseIndex（§8.15.1 编辑上下文检索用）。
   * 不传时跳过编辑上下文注入。
   */
  codebaseIndex?: {
    search(query: string, topK?: number): Promise<{ filePath: string; text: string; startLine: number }[]>;
  };
  /**
   * DebugModeGate，在 Debug 模式下拒绝无证修改。
   * 接收工具名，返回 'allow' 或 'block'。
   * 由调用方（panel.ts）维护 hasEvidence 状态和 Mode 判断。
   */
  debugModeGate?: (toolName: string) => { verdict: 'allow' | 'block'; message?: string };
}

/**
 * 累积 tool_call 解析状态（来自 stream 增量事件）
 */
interface ToolCallAccumulator {
  id: string;
  name: string;
  /** 用数组累积 delta，避免 ConsString 深层树导致 V8 扁平化阻塞 */
  argsParts: string[];
}

export class TaskLoop {
  readonly taskId: string;
  private readonly provider: IProvider;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolRunner: ToolRunner;
  private readonly history: MessageHistory;
  private readonly workspaceRoot: string | undefined;
  private readonly maxTurns: number;
  private readonly onEvent?: (event: TaskEvent) => void;
  private readonly hookManager?: HookManager;
  /** W15.8 · 流式文件写入器 — 在 tool_args_delta 阶段实时写磁盘 */
  private readonly streamingWriter: StreamingFileWriter | undefined;
  /** P0-7 · 实时 Diff 渲染 — 在 tool_args_delta 阶段实时渲染到编辑器 */
  private readonly streamingDiffView: StreamingDiffViewProvider | undefined;
  private readonly toolFilter?: TaskLoopToolFilter;
  private readonly contextManager?: ContextManager;
  /** W15.5 · 本 Loop 所有轮次透传到 provider.createMessage 的 modelOverride */
  private readonly modelOverride?: string;
  /** §8.15.1 · 编辑上下文检索 */
  private readonly codebaseIndex?: TaskLoopConfig['codebaseIndex'];

  /** 当前任务的 AbortController —— UI Stop 按钮触发 */
  private abortController: AbortController | null = null;
  private running = false;
  /** 工具侧自愈计数器（W7b5a）—— TaskLoop 生命周期复用，send() 结束 clear */
  private readonly healingTracker = new HealingTracker();
  /** W15.3 · 动态 prompt 修正器 —— 重复错误模式触发 system prompt 约束注入 */
  private readonly promptModifier = new DynamicPromptModifier();
  /** §8.11.2 · 文件变更冲突检测缓存 */
  private readonly fileStateCache: FileStateCache | undefined;
  // ─── §8.12.2 · 编辑失败路由降级 ───
  private editToolFailures = 0;
  private editToolDegradeCount = 0;
  private isDegraded = false;
  /** DebugModeGate hasEvidence：本轮 send() 生命周期内是否调过取证工具 */
  private evidenceToolCalled = false;
  private static readonly MAX_DEGRADE = 2;
  private static readonly DEGRADE_THRESHOLD = 3;
  private static readonly REASONING_MODEL = 'deepseek-reasoner';
  /** 需要路由降级的编辑工具集合 */
  private static readonly EDIT_TOOLS = new Set(['search_replace', 'write_file', 'append_file', 'delete_file']);


  constructor(cfg: TaskLoopConfig) {
    this.taskId = randomUUID();
    this.provider = cfg.provider;
    this.toolRegistry = cfg.toolRegistry;
    this.toolRunner = new ToolRunner(cfg.toolRegistry, {
      hookManager: cfg.hookManager,
      approvalGate: cfg.approvalGate,
      auditSink: cfg.auditSink,
      approvalOverrides: cfg.approvalOverrides,
      approvalPolicyTable: cfg.approvalPolicyTable,
      debugModeGate: cfg.debugModeGate,
    });
    this.history = new MessageHistory(cfg.systemPrompt);
    if (cfg.initialMessages && cfg.initialMessages.length > 0) {
      this.history.restore(cfg.initialMessages);
    }
    this.workspaceRoot = cfg.workspaceRoot;
    this.maxTurns = cfg.maxTurns ?? DEFAULT_MAX_TURNS;
    this.onEvent = cfg.onEvent;
    this.hookManager = cfg.hookManager;
    this.toolFilter = cfg.toolFilter;
    this.contextManager = cfg.contextManager;
    this.modelOverride = cfg.modelOverride;
    this.codebaseIndex = cfg.codebaseIndex;
    // §8.11.2 · 文件变更冲突检测缓存
    this.fileStateCache = cfg.workspaceRoot ? new FileStateCache() : undefined;
    // W15.8 · 流式文件写入器（需 workspaceRoot）
    this.streamingWriter = cfg.workspaceRoot
      ? new StreamingFileWriter(cfg.workspaceRoot)
      : undefined;
    // P0-7 v2 · 实时 Diff 渲染（WorkspaceEdit + 虚拟 URI scheme，参考 Cline/Roo Code）
    this.streamingDiffView = cfg.workspaceRoot
      ? new StreamingDiffViewProvider(cfg.workspaceRoot)
      : undefined;
  }

  /** UI Stop 按钮调用 */
  abort(): void {
    if (this.abortController && this.running) {
      this.abortController.abort(new Error('user_abort'));
      log.info({ taskId: this.taskId }, 'TaskLoop aborted by user');
    }
  }

  /**
   * 用户发起一次请求。
   * 可能触发多轮（工具调用后继续）。
   * @param userInput 用户文本（Hook/emit/history 文本字段使用）
   * @param images    可选图像 DataURL 数组（W7c）；非空时 history 会把 content 组装为 ContentPart[]
   *                   → Provider router 根据 needsVision 自动路由到 Qwen-VL / GPT-4o / Claude Vision
   * @returns 终止状态：ok=true 表示正常完成，ok=false + errorCode 表示错误终止
   */
  async send(userInput: string, images?: readonly string[]): Promise<{
    ok: boolean;
    errorCode?: string;
    errorMessage?: string;
  }> {
    if (this.running) {
      throw new AgentError({
        code: ErrorCodes.TASK_LOOP_INFINITE,
        message: 'TaskLoop is already running; call abort() first',
      });
    }
    this.running = true;
    this.abortController = new AbortController();
    // W15.3 · 新任务开始时重置动态 prompt 修正器
    this.promptModifier.clearAll();
    // DebugModeGate · 新任务开始时重置取证状态
    this.evidenceToolCalled = false;
    // P0-7 · 内存诊断：send() 开始时记录基线
    const memStart = process.memoryUsage();
    log.info(
      { heapUsedMB: Math.round(memStart.heapUsed / 1024 / 1024), heapTotalMB: Math.round(memStart.heapTotal / 1024 / 1024), rssMB: Math.round(memStart.rss / 1024 / 1024), historySize: this.history.size() },
      'TaskLoop: send() start memory baseline',
    );

    // Hook: pre_task（支持 deny）
    if (this.hookManager) {
      const prePayload: PreTaskPayload = {
        event: 'pre_task',
        taskId: this.taskId,
        timestamp: Date.now(),
        userInput: truncate(userInput, 4000),
      };
      try {
        const outcome = await this.hookManager.emit(prePayload, this.abortController.signal);
        if (outcome.denied) {
          const denier = outcome.denier;
          this.emit({ type: 'task_start', taskId: this.taskId, userInput });
          this.emit({
            type: 'task_end',
            taskId: this.taskId,
            reason: 'error',
            errorCode: ErrorCodes.HOOK_DENIED,
            errorMessage: `任务被 hook ${denier?.spec.name ?? ''} 拦截（exit ${denier?.exitCode ?? '-'}）`,
          });
          this.running = false;
          this.abortController = null;
          return { ok: false, errorCode: ErrorCodes.HOOK_DENIED, errorMessage: `任务被 hook ${denier?.spec.name ?? ''} 拦截` };
        }
      } catch (e) {
        log.warn({ err: String(e) }, 'pre_task hook failed; continue');
      }
    }

    this.history.addUser(userInput, images);
    this.emit({ type: 'task_start', taskId: this.taskId, userInput });

    let taskOk = true;
    let taskErrorCode: string | undefined;
    let taskErrorMessage: string | undefined;
    let finalAssistantText = '';
    let toolCallCount = 0;

    try {
      const stats = await this.runUntilTerminal();
      toolCallCount = stats.toolCalls;
      finalAssistantText = stats.finalAssistantText;
      taskOk = stats.ok;
      // W15.7 · 透传终止错误码给 panel 层，用于 fallback 决策
      if (!stats.ok && stats.errorCode) {
        taskErrorCode = stats.errorCode;
        taskErrorMessage = stats.errorMessage;
      }
    } catch (e) {
      taskOk = false;
      const err = toAgentError(e, ErrorCodes.INTERNAL_UNKNOWN);
      taskErrorCode = err.code;
      taskErrorMessage = err.toUserMessage();
      log.error(
        { taskId: this.taskId, code: err.code, msg: err.message },
        'TaskLoop unexpected failure',
      );
      this.emit({
        type: 'task_end',
        taskId: this.taskId,
        reason: 'error',
        errorCode: err.code,
        errorMessage: err.toUserMessage(),
      });
      // Hook: on_error
      if (this.hookManager) {
        const errPayload: OnErrorPayload = {
          event: 'on_error',
          taskId: this.taskId,
          timestamp: Date.now(),
          errorCode: err.code,
          message: err.message,
        };
        try {
          await this.hookManager.emit(errPayload);
        } catch (hookErr) {
          log.warn({ err: String(hookErr) }, 'on_error hook failed');
        }
      }
    } finally {
      // Hook: post_task（失败也发）
      if (this.hookManager) {
        const postPayload: PostTaskPayload = {
          event: 'post_task',
          taskId: this.taskId,
          timestamp: Date.now(),
          toolCalls: toolCallCount,
          assistantText: truncate(finalAssistantText, 4000),
          ok: taskOk,
        };
        try {
          await this.hookManager.emit(postPayload);
        } catch (e) {
          log.warn({ err: String(e) }, 'post_task hook failed');
        }
      }
      this.running = false;
      this.abortController = null;
    }

    return { ok: taskOk, errorCode: taskErrorCode, errorMessage: taskErrorMessage };
  }

  /** 供测试 / UI 读取完整历史 */
  getHistorySnapshot() {
    return this.history.snapshot();
  }

  // ─────────── 内部循环 ───────────

  /** SSE 断裂自动重推最大次数（对齐 codes.ts RETRY_TABLE 中 STREAM_BROKEN 的 attempts:5） */
  private static readonly MAX_STREAM_BROKEN_RETRIES = 5;
  /** SSE 断裂重推退避基数（ms） */
  private static readonly STREAM_BROKEN_BACKOFF_MS = 1500;

  private async runUntilTerminal(): Promise<{
    toolCalls: number;
    finalAssistantText: string;
    ok: boolean;
    errorCode?: string;
    errorMessage?: string;
  }> {
    let totalToolCalls = 0;
    let lastAssistantText = '';
    let streamBrokenRetries = 0;

    for (let turn = 1; turn <= this.maxTurns; turn++) {
      this.emit({ type: 'turn_start', taskId: this.taskId, turn });

      const outcome = await this.runOneTurn();

      if (outcome === 'aborted') {
        this.emit({ type: 'task_end', taskId: this.taskId, reason: 'aborted' });
        return { toolCalls: totalToolCalls, finalAssistantText: lastAssistantText, ok: false };
      }
      if ('assistantText' in outcome && typeof outcome.assistantText === 'string') {
        lastAssistantText = outcome.assistantText;
      }
      if ('toolCallCount' in outcome && typeof outcome.toolCallCount === 'number') {
        totalToolCalls += outcome.toolCallCount;
      }
      if (outcome.kind === 'error') {
        // ── P0-6: SSE 断裂改为"清除本轮+重推" ──
        // 不再注入伪消息（污染历史），而是清除本轮不完整的 assistant 消息，
        // 然后重推原始 user 输入让 LLM 从头生成。
        const isRecoverable = outcome.code === ErrorCodes.PROVIDER_STREAM_BROKEN
          || outcome.code === ErrorCodes.PROVIDER_BAD_REQUEST;
        if (isRecoverable && streamBrokenRetries < TaskLoop.MAX_STREAM_BROKEN_RETRIES) {
          streamBrokenRetries++;
          const delay = TaskLoop.STREAM_BROKEN_BACKOFF_MS * streamBrokenRetries;
          log.info(
            { taskId: this.taskId, retry: streamBrokenRetries, maxRetries: TaskLoop.MAX_STREAM_BROKEN_RETRIES, delayMs: delay },
            '[P0-6] STREAM_BROKEN: clearing current turn + re-pushing (no pseudo-message injection)',
          );
          this.emit({
            type: 'text_delta',
            taskId: this.taskId,
            text: `\n\n⚠️ [流中断重试 ${streamBrokenRetries}/${TaskLoop.MAX_STREAM_BROKEN_RETRIES}]\n`,
          });
          // 退避等待
          await new Promise((r) => setTimeout(r, delay));
          // 清除本轮不完整的 assistant 消息（历史尾部如果有 assistant，移除它）
          this.history.cleanupTrailingIncompleteToolCalls();
          this.history.removeTrailingAssistant();
          // 不注入任何伪消息——下一轮 runOneTurn 会用完整的历史重新请求 LLM
          continue; // 继续下一轮循环，不终止
        }

        this.emit({
          type: 'task_end',
          taskId: this.taskId,
          reason: 'error',
          errorCode: outcome.code,
          errorMessage: outcome.message,
        });
        return { toolCalls: totalToolCalls, finalAssistantText: lastAssistantText, ok: false, errorCode: outcome.code, errorMessage: outcome.message };
      }
      if (outcome.kind === 'completed') {
        // W-UI10 · 如果本轮没有助理文本（纯 tool call 场景），补一条总结提示
        if (!lastAssistantText?.trim() && totalToolCalls > 0) {
          const summary = `✅ 任务执行完成，共调用 ${totalToolCalls} 个工具。`;
          this.emit({ type: 'text_delta', taskId: this.taskId, text: summary });
          lastAssistantText = summary;
        }
        this.emit({ type: 'task_end', taskId: this.taskId, reason: 'completed' });
        return { toolCalls: totalToolCalls, finalAssistantText: lastAssistantText, ok: true };
      }
      // tool_use —— 已在本方法内把 tool 结果塞回 history，继续下一轮
    }

    log.warn({ taskId: this.taskId, maxTurns: this.maxTurns }, 'TaskLoop hit max_turns');
    this.emit({
      type: 'task_end',
      taskId: this.taskId,
      reason: 'max_turns',
      errorCode: ErrorCodes.TASK_LOOP_INFINITE,
      errorMessage: `达到最大轮次 ${this.maxTurns}，已终止`,
    });
    return { toolCalls: totalToolCalls, finalAssistantText: lastAssistantText, ok: false, errorCode: ErrorCodes.TASK_LOOP_INFINITE, errorMessage: `达到最大轮次 ${this.maxTurns}，已终止` };
  }

  private async runOneTurn(): Promise<
    | 'aborted'
    | { kind: 'completed'; assistantText: string; toolCallCount: number }
    | { kind: 'continue'; assistantText: string; toolCallCount: number }
    | { kind: 'error'; code: string; message: string; assistantText?: string; toolCallCount?: number }
  > {
    const signal = this.abortController!.signal;

    // 累积本轮 assistant 文本与工具调用
    let assistantText = '';
    let reasoningText = '';
    const toolCalls = new Map<string, ToolCallAccumulator>();
    // 保留 tool_call 首次出现的顺序（Map 天然保留插入顺序）

    let doneReason: string | null = null;
    let errorPayload: { code: string; message: string } | null = null;

    try {
      const toolSchemas =
        this.toolRegistry.list().length > 0
          ? this.toolRegistry.toToolSchemas(this.toolFilter)
          : undefined;
      // P0-7 · 内存诊断：runOneTurn 开始时记录
      const memTurnStart = process.memoryUsage();
      log.info(
        { heapUsedMB: Math.round(memTurnStart.heapUsed / 1024 / 1024), historySize: this.history.size() },
        'TaskLoop: runOneTurn start',
      );
      // W8 · Context Management：压缩历史消息 + 发射 context_stats（W8.3）
      const rawMessages = this.history.snapshot();
      let messages = rawMessages;
      if (this.contextManager) {
        const compressed = this.contextManager.compress(rawMessages);
        messages = compressed.messages;
        this.emit({
          type: 'context_stats',
          taskId: this.taskId,
          level: compressed.level,
          originalTokens: compressed.originalTokens,
          compressedTokens: compressed.compressedTokens,
          savingsPercent: compressed.savingsPercent,
          inputBudget: this.contextManager.inputBudget,
        });
        // §8.14 · 语义摘要：当压缩级别为 medium/heavy 时，尝试用 LLM 回环摘要代替机械摘要
        if (compressed.level === 'medium' || compressed.level === 'heavy') {
          try {
            const { compactWithSummary, groupTurns: gt } = await import('../context/manager.js');
            const turns = gt(rawMessages);
            const protectedCount = this.contextManager['opts'].protectedTurns;
            const compactableTurnCount = turns.length - protectedCount;
            if (compactableTurnCount > 0) {
              const semanticMessages = await compactWithSummary({
                messages: rawMessages,
                turns,
                compactableTurnCount,
                protectedCount,
                provider: this.provider,
                signal: this.abortController?.signal,
              });
              if (semanticMessages) {
                messages = semanticMessages;
              }
            }
          } catch {
            // 超时/异常 → 保留机械压缩结果
          }
        }
      }
      // §8.12.1 · 动态 prompt 修正：重复错误模式 → 将 <heuristic> 约束追加到 system prompt
      // 每条 pattern 限注入 1 次
      if (this.promptModifier.hasConstraints()) {
        for (const pattern of this.promptModifier.snapshot()) {
          const match = this.promptModifier.detectPattern(pattern.toolName, pattern.errorCode);
          if (match && !match.injected) {
            this.promptModifier.markInjected(match.patternName);
          }
        }
        const constraints = this.promptModifier.buildConstraints();
        if (constraints.length > 0 && messages[0]?.role === 'system') {
          messages = messages.map((m, i) =>
            i === 0 ? { ...m, content: `${m.content}\n\n${constraints.join('\n\n')}` } : m,
          );
        }
      }
      // ── Safety cap: 90% context window overflow prevention ──
      // 在调用 provider.createMessage 前粗估消息 token 数。
      // 若已超过 contextWindow 的 90%，直接返回 error 而不是等 API 报 400。
      // DeepSeek context_window=1M, 90%=900K, 按 /4 估≈3.6M 字符。
      // 这是粗估（不精确所以留 10% 余量），防止 334 万 token 级别的灾难性溢出。
      const ctxWindow = this.provider.contextWindow || 1_048_576;
      if (messages.length > 0) {
        const estimatedTokens = await this.provider.countTokens(messages).catch(() => 0);
        const safetyThreshold = Math.floor(ctxWindow * 0.9);
        if (estimatedTokens > safetyThreshold) {
          const overflowMsg =
            `Error: 消息历史过长（约 ${estimatedTokens.toLocaleString()} tokens），` +
            `已超过 Provider 上下文窗口 90%（${safetyThreshold.toLocaleString()}）。` +
            `请开始新会话或简化需求。`;
          log.warn(
            { estimatedTokens, ctxWindow, safetyThreshold },
            '[Safety Cap] estimated tokens exceed 90% of context window',
          );
          return {
            kind: 'error' as const,
            code: ErrorCodes.PROVIDER_RESP_CONTEXT_OVERFLOW,
            message: overflowMsg,
            assistantText: '',
            toolCallCount: 0,
          };
        }
      }

      const effectiveOverride = getEffectiveModelOverride(this.modelOverride, this.isDegraded);
      const stream: AsyncIterable<StreamEvent> = this.provider.createMessage({
        messages,
        tools: toolSchemas && toolSchemas.length > 0 ? toolSchemas : undefined,
        signal,
        ...(effectiveOverride ? { modelOverride: effectiveOverride } : {}),
      });

      let lastEventTime = Date.now();
      for await (const ev of stream) {
        if (signal.aborted) return 'aborted';
        const now = Date.now();
        const elapsed = now - lastEventTime;
        if (elapsed > 1000) {
          log.warn({ elapsed, eventType: ev.type }, 'TaskLoop: long gap between stream events (>1s)');
        }
        lastEventTime = now;

        switch (ev.type) {
          case 'text_delta':
            assistantText += ev.text;
            // P0-7 · 防止 assistantText 无限增长导致内存爆炸
            if (assistantText.length > 200_000) {
              assistantText = assistantText.slice(0, 200_000) + '\n...[assistant text truncated]';
            }
            this.emit({ type: 'text_delta', taskId: this.taskId, text: ev.text });
            break;

          case 'reasoning_delta':
            reasoningText += ev.text;
            // P0-7 · 防止 reasoningText 无限增长
            if (reasoningText.length > 100_000) {
              reasoningText = reasoningText.slice(0, 100_000) + '\n...[reasoning text truncated]';
            }
            this.emit({ type: 'reasoning_delta', taskId: this.taskId, text: ev.text });
            break;

          case 'tool_start':
            toolCalls.set(ev.id, { id: ev.id, name: ev.name, argsParts: [] });
            this.emit({
              type: 'tool_start',
              taskId: this.taskId,
              toolCallId: ev.id,
              name: ev.name,
            });
            // W15.8 · 流式写入：tool_start 时注册（v2: 写临时文件）
            if (this.streamingWriter?.isStreamWriteTool(ev.name)) {
              void this.streamingWriter.onToolStart(ev.id, ev.name).catch((e) => {
                log.warn({ err: String(e), toolCallId: ev.id }, 'streamingWriter onToolStart failed');
              });
            }
            // P0-7 · 实时 Diff 渲染：已禁用（方案A）
            break;

          case 'tool_args_delta': {
            const acc = toolCalls.get(ev.id);
            if (acc) {
              const t0 = performance.now();
              acc.argsParts.push(ev.partial);
              this.emit({
                type: 'tool_args_delta',
                taskId: this.taskId,
                toolCallId: ev.id,
                partial: ev.partial,
              });
              // W15.8 · 流式写入：每次 delta 时增量写磁盘
              if (this.streamingWriter && this.streamingWriter.isStreamWriteTool(acc.name)) {
                const argsRaw = acc.argsParts.join('');
                void this.streamingWriter.onToolArgsDelta(ev.id, argsRaw).catch((e) => {
                  log.warn({ err: String(e), toolCallId: ev.id }, 'streamingWriter delta failed');
                });
              }
              // P0-7 · 实时 Diff 渲染：已禁用（方案A）
              const dt = performance.now() - t0;
              if (dt > 50) {
                log.warn({ dt, toolCallId: ev.id, partialLen: ev.partial.length, partsCount: acc.argsParts.length }, 'TaskLoop: slow tool_args_delta handling');
              }
            }
            break;
          }

          case 'tool_end': {
            // P0-7 · 实时 Diff 渲染：已禁用（方案A）
            break;
          }

          case 'usage':
            this.emit({
              type: 'usage',
              taskId: this.taskId,
              promptTokens: ev.promptTokens,
              completionTokens: ev.completionTokens,
              ...(ev.cachedTokens !== undefined ? { cachedTokens: ev.cachedTokens } : {}),
            });
            break;

          case 'error':
            errorPayload = { code: ev.error.code, message: ev.error.message };
            break;

          case 'done':
            doneReason = ev.reason;
            break;
        }
      }
    } catch (e) {
      const err = toAgentError(e, ErrorCodes.PROVIDER_STREAM_BROKEN);
      return { kind: 'error', code: err.code, message: err.toUserMessage() };
    }

    if (signal.aborted) return 'aborted';

    // Provider 发过 error → 终止
    if (errorPayload) {
      return { kind: 'error', code: errorPayload.code, message: errorPayload.message };
    }

    // 把 assistant 消息塞进历史
    // W15.6b: 如果 done 原因是 error，说明流断裂，toolCalls 可能不完整；
    // 不写入 toolCalls 到历史，否则后续请求会因为 assistant 有 tool_calls
    // 但缺少对应的 tool 回复而被 DeepSeek API 拒绝（HTTP 400）。
    const isStreamError = doneReason === 'error';
    // W15.8 · 流断裂时通知 StreamingFileWriter 保留已写入内容
    if (isStreamError && this.streamingWriter) {
      await this.streamingWriter.onStreamBroken();
    }
    // P0-7 · 实时 Diff 渲染：已禁用（方案A）
    // 完整 argsRaw（工具执行需要完整的 content 参数）
    const rawCalls: ToolCall[] = isStreamError
      ? []
      : Array.from(toolCalls.values()).map((c) => ({
          id: c.id,
          name: c.name,
          argsRaw: c.argsParts.join(''),
        }));
    // 截断的 argsRaw（仅用于历史消息，防止大 content 膨胀 CTX）
    // 方案 B：write_file/append_file 的 content 字段完全移除，只有 _truncated 标记
    // content 已由 StreamingFileWriter 写入临时文件，LLM 不需要在历史中看到它
    const historyCalls: ToolCall[] = isStreamError
      ? []
      : Array.from(toolCalls.values()).map((c) => ({
          id: c.id,
          name: c.name,
          argsRaw: truncateArgsRawForHistory(c.argsParts.join(''), c.name),
        }));
    const memBefore = process.memoryUsage();
    this.history.addAssistant({
      content: assistantText,
      toolCalls: historyCalls.length > 0 ? historyCalls : undefined,
      reasoningContent: reasoningText || undefined,
    });
    log.info(
      { heapUsedMB: Math.round(memBefore.heapUsed / 1024 / 1024), argsRawTotalKB: Math.round(historyCalls.reduce((sum, c) => sum + c.argsRaw.length, 0) / 1024) },
      'TaskLoop: assistant message added to history',
    );

    // 非工具调用 → 本轮结束
    if (doneReason !== 'tool_use' || rawCalls.length === 0) {
      return { kind: 'completed', assistantText, toolCallCount: 0 };
    }

    // §8.15.1 · 编辑上下文注入：检测本轮是否包含编辑工具，若是则从 CodebaseIndex
    // 检索目标文件的符号信息和相邻导出，追加到 system prompt 末尾。
    // 将上下文写入 history 的首条 system 消息，供后续 LLM 轮次看见。
    const editContextXml = await buildEditContextForTurn(rawCalls, this.workspaceRoot, this.codebaseIndex);
    if (editContextXml) {
      this.history.addSystemSuffix(editContextXml);
    }

    // 执行工具调用（顺序执行，MVP 简化）
    const healingTracker = this.healingTracker;
    for (const call of rawCalls) {
      if (signal.aborted) return 'aborted';

      const parsed = parseToolArgs(call.argsRaw);
      const args = parsed.ok ? parsed.args : {};

      // W15.9 · 空参数保护：SSE 断裂后非流式 fallback 可能返回 args 为空的 tool call，
      // 导致 write_file 执行时 file_path 为空、resolveWriteTarget 返回 undefined、
      // pendingDiff 未设置 → Accept/Reject UI 消失。
      // 对于已知的必填参数工具，空 args 直接返回错误，不执行。
      const REQUIRED_ARGS_TOOLS = new Set(['write_file', 'append_file', 'search_replace', 'delete_file']);
      if (parsed.ok && REQUIRED_ARGS_TOOLS.has(call.name) && Object.keys(args).length === 0) {
        const emptyMsg = `Error: 工具 ${call.name} 收到空参数。这通常是因为 SSE 流断裂后重试返回了不完整的 tool call。请重新生成完整的参数再调用。`;
        this.history.addToolResult(call.id, emptyMsg, call.name);
        this.emit({
          type: 'tool_exec_start',
          taskId: this.taskId,
          toolCallId: call.id,
          name: call.name,
          args,
        });
        this.emit({
          type: 'tool_exec_end',
          taskId: this.taskId,
          toolCallId: call.id,
          name: call.name,
          ok: false,
          contentPreview: truncate(emptyMsg, 500),
          errorCode: ErrorCodes.TOOL_ARGS_INVALID,
        });
        continue;
      }

      // 先检查 Mode 白名单和 JSON 合法性，这些同步检查不需要审批
      const tool = this.toolRegistry.get(call.name);
      // Mode 白名单二次校验
      if (this.toolFilter && tool && !this.toolFilter(tool)) {
        const blockedMsg = `Error: 工具 "${call.name}" 在当前 Mode 下不可用，已阻止执行。请切换到合适的 Mode 或改用允许的工具。`;
        this.history.addToolResult(call.id, blockedMsg, call.name);
        this.emit({
          type: 'tool_exec_end',
          taskId: this.taskId,
          toolCallId: call.id,
          name: call.name,
          ok: false,
          contentPreview: blockedMsg,
          errorCode: ErrorCodes.TOOL_EXEC_UNSAFE_BLOCKED,
        });
        continue;
      }
      // 工具侧自愈场景 1：arguments JSON 解析失败
      if (!parsed.ok) {
        const baseMsg = `Error: 工具 ${call.name} 的 arguments 不是合法 JSON：${parsed.error}`;
        const healed =
          tryHealTool(
            healingTracker,
            {
              toolName: call.name,
              errorCode: ErrorCodes.TOOL_ARGS_INVALID_JSON,
              errorMessage: parsed.error,
            },
            baseMsg,
          ) ?? baseMsg;
        this.promptModifier.record(call.name, ErrorCodes.TOOL_ARGS_INVALID_JSON);
        this.history.addToolResult(call.id, healed, call.name);
        this.emit({
          type: 'tool_exec_end',
          taskId: this.taskId,
          toolCallId: call.id,
          name: call.name,
          ok: false,
          contentPreview: truncate(healed, 500),
          errorCode: ErrorCodes.TOOL_ARGS_INVALID_JSON,
        });
        continue;
      }

      // ─── tool_exec_start 推迟到同步校验之后、ToolRunner.run() 之前 ───
      // 这样当 ToolRunner.run() 内部遇到 approvalGate 阻塞时，
      // webview 已经收到 tool_exec_start，ToolCard 状态为 running，
      // 随后的 approval_request 会追加到 pendingApprovalToolIds，
      // ToolCard 能同时显示"正在处理..."和审批按钮。
      this.emit({
        type: 'tool_exec_start',
        taskId: this.taskId,
        toolCallId: call.id,
        name: call.name,
        args,
      });

      // 累积中间输出，用于 tool_exec_output 事件
      // 增量 emit：每次只发新增的部分，webview 端自行追加
      let toolOutputBuffer = '';
      let toolOutputLastLen = 0;
      // 空闲 flush 定时器：当终端输出无换行（进度条/长单行）时，
      // 每隔 200ms 强制推送一次 buffer，确保 UI 能实时看到输出
      let outputFlushTimer: ReturnType<typeof setInterval> | undefined;
      const startOutputFlush = () => {
        if (outputFlushTimer) return;
        outputFlushTimer = setInterval(() => {
          if (toolOutputBuffer.length > toolOutputLastLen) {
            const delta = toolOutputBuffer.slice(toolOutputLastLen);
            if (delta.length > 0) {
              toolOutputLastLen = toolOutputBuffer.length;
              this.emit({
                type: 'tool_exec_output',
                taskId: this.taskId,
                toolCallId: call.id,
                contentPreview: delta,
                isDelta: true,
              });
            }
          }
        }, 200);
        outputFlushTimer.unref?.();
      };
      // 发送一条初始占位 output，让 UI 立即看到 ToolCard 的 body（CommandOutputRow）
      // 这对 bash 工具尤其重要——approvalGate 阻塞期间无任何输出，
      // 此占位让用户知道"命令已就绪，等待执行/审批"
      if (call.name === 'bash') {
        const commandStr = typeof (args as Record<string, unknown>)?.command === 'string'
          ? (args as Record<string, unknown>).command as string
          : '';
        toolOutputBuffer = `$ ${commandStr}\n`;
        toolOutputLastLen = toolOutputBuffer.length;
        this.emit({
          type: 'tool_exec_output',
          taskId: this.taskId,
          toolCallId: call.id,
          contentPreview: toolOutputBuffer,
          isDelta: false,
        });
      }
      // 在 tool_exec_start 之后立即启动 flush 定时器，不等待首次 onOutput。
      // 即使工具在 approvalGate 上阻塞，UI 也能每 200ms 收到一次心跳推送。
      startOutputFlush();
      const stopOutputFlush = () => {
        if (outputFlushTimer) {
          clearInterval(outputFlushTimer);
          outputFlushTimer = undefined;
        }
      };
      const result = await this.toolRunner.run({
        toolCallId: call.id,
        name: call.name,
        args,
        workspaceRoot: this.workspaceRoot,
        signal,
        taskId: this.taskId,
        fileStateCache: this.fileStateCache,
        onOutput: (output: string) => {
          toolOutputBuffer += output;
          // 只 emit 新增部分，避免全量截断导致的"相同长度跳过更新"
          const delta = toolOutputBuffer.slice(toolOutputLastLen);
          if (delta.length > 0) {
            toolOutputLastLen = toolOutputBuffer.length;
            this.emit({
              type: 'tool_exec_output',
              taskId: this.taskId,
              toolCallId: call.id,
              contentPreview: delta,
              isDelta: true,
            });
          }
        },
      });
      // 工具执行完毕，停止空闲 flush 并推送最后剩余的 buffer
      stopOutputFlush();
      if (toolOutputBuffer.length > toolOutputLastLen) {
        const delta = toolOutputBuffer.slice(toolOutputLastLen);
        if (delta.length > 0) {
          this.emit({
            type: 'tool_exec_output',
            taskId: this.taskId,
            toolCallId: call.id,
            contentPreview: delta,
            isDelta: true,
          });
        }
      }

      // ─── DebugModeGate：工具执行完毕后更新取证状态 ───
      // 无论结果如何，只要 LLM 尝试了取证工具即视为已取证
      // （即使失败，LLM 也可以通过输出判断失败原因）
      if (isEvidenceTool(call.name)) {
        this.evidenceToolCalled = true;
      }

      // ─── 工具侧自愈场景 2/3：工具返回失败 + 命中 healing table → 注入 hint ───
      let finalContent = result.content;
      if (!result.ok && result.errorCode) {
        const healed = tryHealTool(
          healingTracker,
          {
            toolName: call.name,
            errorCode: result.errorCode,
            errorMessage: result.content,
          },
          result.content,
        );
        if (healed) finalContent = healed;
        // W15.3 · 记录工具执行失败模式
        this.promptModifier.record(call.name, result.errorCode);
        // §8.12.2 · 编辑工具失败计数
        if (TaskLoop.EDIT_TOOLS.has(call.name)) {
          this.editToolFailures++;
        }
      } else if (result.ok) {
        // 成功即重置该 (tool, *) 所有 healing 计数不安全（需枚举），
        // 这里仅重置当前任务中最常见的几个错误码以释放预算
        healingTracker.reset(call.name, ErrorCodes.TOOL_ARGS_INVALID_JSON);
        healingTracker.reset(call.name, ErrorCodes.TOOL_PATCH_UNIQUE_FAIL);
        healingTracker.reset(call.name, ErrorCodes.TOOL_PATCH_NO_MATCH);
        // W15.3 · 成功执行后清除该工具的动态约束
        this.promptModifier.clear(call.name);
        // §8.12.2 · 编辑工具成功 → 重置降级计数和标志
        if (TaskLoop.EDIT_TOOLS.has(call.name)) {
          this.editToolFailures = 0;
          this.isDegraded = false;
        }
      }

      this.history.addToolResult(call.id, finalContent, call.name);

      // tool_exec_end 的 contentPreview：
      // - 失败时传 finalContent（含可能的 healing hint 或原始错误文本），
      //   让 webview 显示错误信息给用户看到
      // - 成功时传空，由 webview 保留已有的流式终端输出
      const endContentPreview = !result.ok ? truncate(finalContent, 500) : '';
      this.emit({
        type: 'tool_exec_end',
        taskId: this.taskId,
        toolCallId: call.id,
        name: call.name,
        ok: result.ok,
        contentPreview: endContentPreview,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      });
      // W15.8 · 工具正常执行完毕，通知 StreamingFileWriter 清理临时文件
      // （工具本身的 writeFile 已写入真实文件，临时文件不再需要）
      void this.streamingWriter?.onToolExecComplete(call.id).catch((e) => {
        log.warn({ err: String(e), toolCallId: call.id }, 'streamingWriter onToolExecComplete failed');
      });
      // P0-7 · 工具执行完毕，关闭 Diff 编辑器
      this.streamingDiffView?.close(call.id);
    }

    // §8.12.2 · 降级触发判断：编辑工具连续失败 ≥ threshold 且未超降级次数
    if (this.editToolFailures >= TaskLoop.DEGRADE_THRESHOLD
        && this.editToolDegradeCount < TaskLoop.MAX_DEGRADE && !this.isDegraded) {
      this.editToolDegradeCount++;
      this.isDegraded = true;
      log.info(
        { failures: this.editToolFailures, degradeCount: this.editToolDegradeCount },
        '[Degrade] routing next turn to reasoning model',
      );
    }

    // §8.13 · 编辑后 LSP Diagnostics 主动注入
    // 只在有编辑工具成功执行且不是 VSCode extension host testing 环境时触发
    if (typeof process === 'undefined' || process.env.VSCODE_IN_TEST !== '1') {
      await injectPostEditDiagnostics(rawCalls, this.workspaceRoot, this.history);
    }

    // §8.15.2 · 编辑后符号验证（verifyReferences）
    // 对成功执行的编辑工具检查 import/require 符号是否在目标模块中有导出。
    if (this.workspaceRoot && this.codebaseIndex) {
      await injectPostEditVerification(rawCalls, this.workspaceRoot, this.codebaseIndex, this.history);
    }

    return { kind: 'continue', assistantText, toolCallCount: rawCalls.length };
  }

  private emit(event: TaskEvent): void {
    try {
      this.onEvent?.(event);
    } catch (e) {
      log.warn({ err: String(e), eventType: event.type }, 'onEvent listener threw');
    }
  }
}

// ─────────── helpers ───────────

type ParseToolArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * 解析 LLM 生成的工具 arguments（严格版，W7b5a）。
 * - 空串/纯空白 → `{ ok:true, args:{} }`（部分工具允许无参）
 * - 合法 JSON 对象 → `{ ok:true, args }`
 * - 非对象（数组 / 原子值）→ `{ ok:false, error }`
 * - JSON.parse 抛异常 → `{ ok:false, error: SyntaxError.message }`
 *
 * 与旧 `safeParseArgs` 的差异：不再吞异常，保留错误供 tool-healing 生成 hint。
 */
function parseToolArgs(raw: string): ParseToolArgsResult {
  if (!raw || !raw.trim()) return { ok: true, args: {} };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    return { ok: true, args: obj as Record<string, unknown> };
  }
  return { ok: false, error: `arguments 必须是 JSON 对象，实际类型：${Array.isArray(obj) ? 'array' : typeof obj}` };
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `\n… (truncated, total ${s.length} chars)`;
}

// ─────────── §8.12.2 · 编辑失败路由降级 ───────────

/** 获取降级后的模型 override */
function getEffectiveModelOverride(
  baseModelOverride: string | undefined,
  isDegraded: boolean,
): string | undefined {
  // static property 访问通过 class 名
  const staticREASONING_MODEL = 'deepseek-reasoner';
  if (isDegraded) return staticREASONING_MODEL;
  return baseModelOverride;
}

/**
 * §8.13 · 编辑后 LSP Diagnostics 自动拉取 + **注入**。
 * search_replace / write_file 成功后等待 200ms 让 LSP 增量编译，然后拉取诊断
 * 并追加到最后一条 tool result 的 content 末尾。
 */
async function injectPostEditDiagnostics(
  rawCalls: readonly ToolCall[],
  workspaceRoot: string | undefined,
  history: MessageHistory,
): Promise<void> {
  if (!workspaceRoot) return;
  // 检查是否有编辑工具
  const editCalls = rawCalls.filter(c =>
    c.name === 'search_replace' || c.name === 'write_file',
  );
  if (editCalls.length === 0) return;

  // 仅限 VSCode extension host 环境，import * as vscode 时做 dynamic import 保护
  let diagnosticsModule: typeof import('../lsp/vscode-bridge.js') | undefined;
  try {
    diagnosticsModule = await import('../lsp/vscode-bridge.js');
  } catch {
    return; // 非 VSCode 环境（测试），跳过
  }

  // 等待 LSP 完成增量解析
  await new Promise(r => setTimeout(r, 200));

  const allParts: string[] = [];
  for (const call of editCalls) {
    // 解析 file_path 参数
    let filePath: string | undefined;
    try {
      const parsed = JSON.parse(call.argsRaw) as Record<string, unknown>;
      const fp = typeof parsed.file_path === 'string' ? parsed.file_path : undefined;
      if (fp) {
        const { isAbsolute, resolve } = await import('node:path');
        filePath = isAbsolute(fp) ? fp : resolve(workspaceRoot, fp);
      }
    } catch {
      continue;
    }
    if (!filePath) continue;

    const diags = diagnosticsModule.getDiagnosticsForFile(filePath);
    const formatted = diagnosticsModule.formatDiagnostics(diags);
    if (formatted) allParts.push(formatted);
  }

  // 将诊断信息追加到最后一条 tool result 末尾
  if (allParts.length > 0) {
    const appendix = allParts.join('\n');
    history.appendToLastToolResult(appendix);
    log.info(
      { diagnosticsCount: allParts.length },
      '[Diagnostics] injected LSP diagnostics after edit',
    );
  }
}

// ─────────── §8.15.1 · 编辑上下文注入 ───────────

/**
 * 为本轮工具调用构建编辑上下文 XML。
 * 扫描 rawCalls 中的编辑工具（search_replace / write_file），
 * 提取目标文件路径，调用 retrieveEditContext 获取符号/导出信息。
 *
 * @returns XML 字符串，或 null（无编辑工具/无可注入内容）
 */
async function buildEditContextForTurn(
  rawCalls: readonly ToolCall[],
  workspaceRoot: string | undefined,
  codebaseIndex: TaskLoopConfig['codebaseIndex'],
): Promise<string | null> {
  if (!workspaceRoot || !codebaseIndex) return null;

  // 收集编辑工具的目标文件路径
  const targetFiles = new Set<string>();
  for (const call of rawCalls) {
    if (call.name !== 'search_replace' && call.name !== 'write_file') continue;
    try {
      const parsed = JSON.parse(call.argsRaw) as Record<string, unknown>;
      const fp = typeof parsed.file_path === 'string' ? parsed.file_path : undefined;
      if (fp) targetFiles.add(fp);
    } catch {
      continue;
    }
  }
  if (targetFiles.size === 0) return null;

  const { retrieveEditContext, formatEditContext } = await import(
    '../index/edit-context-retriever.js'
  );

  const allContexts: string[] = [];
  for (const fp of targetFiles) {
    try {
      const ctx = await retrieveEditContext(fp, workspaceRoot, codebaseIndex);
      if (ctx) allContexts.push(formatEditContext(ctx));
    } catch {
      continue; // 检索失败不阻塞编辑
    }
  }
  return allContexts.length > 0 ? allContexts.join('\n') : null;
}

// ─────────── §8.15.2 · 编辑后符号验证 ───────────

/**
 * 编辑后符号验证注入。
 * 对成功执行的 search_replace / write_file，检查 import/require 的符号
 * 是否在目标模块中有导出，将验证警告追加到最后一条 tool result 末尾。
 */
async function injectPostEditVerification(
  rawCalls: readonly ToolCall[],
  workspaceRoot: string,
  codebaseIndex: Exclude<TaskLoopConfig['codebaseIndex'], undefined>,
  history: MessageHistory,
): Promise<void> {
  const editCalls = rawCalls.filter(c =>
    c.name === 'search_replace' || c.name === 'write_file',
  );
  if (editCalls.length === 0) return;

  const { verifyReferences, formatReferenceIssues } = await import(
    '../index/codebase-index.js'
  );

  // 只验证成功了编辑工具的 file_path
  const verifiedFiles = new Set<string>();
  const allIssues: string[] = [];

  for (const call of editCalls) {
    let filePath: string | undefined;
    try {
      const parsed = JSON.parse(call.argsRaw) as Record<string, unknown>;
      const fp = typeof parsed.file_path === 'string' ? parsed.file_path : undefined;
      if (fp) {
        const { isAbsolute, resolve } = await import('node:path');
        filePath = isAbsolute(fp) ? resolve(workspaceRoot, fp) : fp;
      }
    } catch {
      continue;
    }
    if (!filePath) continue;
    // 避免同一个文件多次验证（可能有多个编辑工具修改同一文件）
    const relPath = filePath.startsWith(workspaceRoot)
      ? filePath.slice(workspaceRoot.length + 1).replace(/\\/g, '/')
      : filePath;
    if (verifiedFiles.has(relPath)) continue;
    verifiedFiles.add(relPath);

    try {
      const issues = await verifyReferences(relPath, workspaceRoot, codebaseIndex);
      if (issues.length > 0) {
        const formatted = formatReferenceIssues(issues);
        if (formatted) allIssues.push(formatted);
      }
    } catch {
      continue; // 验证失败不阻塞编辑流程
    }
  }

  if (allIssues.length > 0) {
    const appendix = allIssues.join('\n');
    history.appendToLastToolResult(appendix);
    log.info(
      { verifiedFiles: verifiedFiles.size, issues: allIssues.length },
      '[Edit Verification] injected reference verification after edit',
    );
  }
}
