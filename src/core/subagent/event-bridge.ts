/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Subagent 事件桥（Agent 工具 → UI 子代理卡片）
 *
 * 把 runSubagent 的内部 TaskEvent 归一化为 SubagentProgressEvent，
 * 经 ToolContext.emitChildEvent 以 `subagent_event` 嵌套事件发到 webview，
 * 由子代理卡片按 parentToolCallId 归位渲染。
 *
 * 设计约束：
 * - 仅 UI 旁路：不写 history、不进 LLM 上下文、不改主消息流
 * - emit 未注入（单测直调 / 无 webview）时整体 no-op，零开销
 * - text_delta 按 100ms 合并节流；遇工具步骤切换或终态时强制 flush，保证事件顺序
 */

import type { SubagentProgressEvent, TaskEvent } from '../../shared/protocol.js';

export interface SubagentBridgeContext {
  /** 主会话 taskId */
  taskId: string;
  /** 主会话中 Agent 工具调用的 toolCallId（webview 归位用） */
  parentToolCallId: string;
  /** 子代理类型（Browser / Research / preset 名等） */
  agentType: string;
  /** 派发描述（卡片首行展示） */
  description: string;
  /** 步数预算（def.maxTurns），供卡片展示进度/ETA；缺省不展示 */
  maxTurns?: number;
  /** ToolContext.emitChildEvent；缺省时整个桥为 no-op */
  emit?: (ev: TaskEvent) => void;
}

export interface SubagentEventBridge {
  /** 传给 runSubagent 的 onEvent */
  onEvent: (ev: TaskEvent) => void;
  /** 强制吐出缓冲文本（步骤切换 / 终态时内部调用，保证事件顺序） */
  flush: () => void;
  /**
   * 终态上报。
   * - 同步路径：agent.ts 在 await / catch 后调用（携带真实 summary）
   * - 后台路径：由内部 `subagent_completed` 映射触发（agent.ts 不重复调用）
   */
  end: (ok: boolean, summary: string, toolCalls: number) => void;
  /** 清理定时器（异常路径兜底，防止悬挂） */
  dispose: () => void;
}

/** 文本增量合并窗口（ms）：避免逐 token 触发 webview 重渲染 */
const TEXT_FLUSH_MS = 100;

export function createSubagentEventBridge(ctx: SubagentBridgeContext): SubagentEventBridge {
  let textBuf = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  /** 桥创建时刻：卡片「已用时 / 总耗时」计算基准 */
  const startedAt = Date.now();
  /** 步骤开始时间：toolId → 子代理内部 tool_exec_start.startTime */
  const stepStartedAt = new Map<string, number>();

  const emit = (progress: SubagentProgressEvent): void => {
    ctx.emit?.({
      type: 'subagent_event',
      taskId: ctx.taskId,
      parentToolCallId: ctx.parentToolCallId,
      agentType: ctx.agentType,
      progress,
    });
  };

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (textBuf.length > 0) {
      const text = textBuf;
      textBuf = '';
      emit({ type: 'subagent_text', text });
    }
  };

  const scheduleFlush = (): void => {
    if (timer) return;
    timer = setTimeout(flush, TEXT_FLUSH_MS);
    timer.unref?.();
  };

  const dispose = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    textBuf = '';
    stepStartedAt.clear();
  };

  const end = (ok: boolean, summary: string, toolCalls: number): void => {
    if (ended) return;
    ended = true;
    flush();
    emit({ type: 'subagent_end', ok, summary, toolCalls, durationMs: Date.now() - startedAt });
  };

  // 首帧：卡片立即进入 running 态（含 agentType / description / 计时基准）
  emit({
    type: 'subagent_start',
    agentType: ctx.agentType,
    description: ctx.description,
    startTime: startedAt,
    ...(ctx.maxTurns ? { maxTurns: ctx.maxTurns } : {}),
  });

  const onEvent = (ev: TaskEvent): void => {
    if (!ctx.emit) return; // 无 UI 通道 → 零开销
    switch (ev.type) {
      case 'text_delta':
        textBuf += ev.text;
        scheduleFlush();
        break;
      case 'tool_exec_start':
        flush(); // 先吐文本再看步骤，保证 UI 顺序
        stepStartedAt.set(ev.toolCallId, ev.startTime);
        emit({
          type: 'subagent_tool_start',
          name: ev.name,
          toolId: ev.toolCallId,
          startTime: ev.startTime,
        });
        break;
      case 'tool_exec_end': {
        const stepStart = stepStartedAt.get(ev.toolCallId);
        stepStartedAt.delete(ev.toolCallId);
        emit({
          type: 'subagent_tool_end',
          name: ev.name,
          toolId: ev.toolCallId,
          ok: ev.ok,
          ...(stepStart !== undefined ? { durationMs: Math.max(0, ev.endTime - stepStart) } : {}),
        });
        break;
      }
      case 'usage':
        emit({
          type: 'subagent_usage',
          promptTokens: ev.promptTokens,
          completionTokens: ev.completionTokens,
          ...(ev.cachedTokens !== undefined ? { cachedTokens: ev.cachedTokens } : {}),
        });
        break;
      case 'subagent_completed':
        // 后台子代理完成（runBackgroundAgent 发射）→ 卡片终态
        end(ev.failed !== true, ev.summary, ev.toolCalls);
        break;
      default:
        // turn_start / tool_start / tool_args_delta / reasoning_delta / task_end ...
        // 子代理卡片不消费这些内部事件，忽略
        break;
    }
  };

  return { onEvent, flush, end, dispose };
}
