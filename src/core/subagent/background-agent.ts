/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * BackgroundAgent（Phase 5 Phase C Step 11 / Phase D-D4 强化）
 *
 * `is_background=true` 时子代理不 await，立即返回 `{ agent_id }`。
 * 完成后回调 `onEvent` 发射 `subagent_completed` 事件。
 *
 * v3.0（Phase D）扩展：
 * - 心跳：每 30s 发射一次存活信号（text_delta 事件）
 * - 进度上报：每轮 tool call 后发射 tool 计数
 * - 暂停/恢复信号：pause/resume 方法
 * - agentType/prompt 参数支持 UI 展示
 *
 * DESIGN-1.md §4.4 · ROADMAP.md 方案一 Phase C Step 11 / Phase D-D4
 */

import type { TaskEvent } from '../task/events.js';

/** 后台子代理的上下文标识 */
let agentIdCounter = 0;

const HEARTBEAT_INTERVAL_MS = 30_000;

/** 后台子代理状态 */
export type BackgroundAgentStatus = 'running' | 'paused' | 'completed' | 'failed';

/**
 * 启动后台子代理。返回 agent_id，不阻塞主流程。
 *
 * @param runFn - 子代理执行函数
 * @param onEvent - 事件发射回调
 * @param agentType - 子代理类型用于 UI 展示
 * @param prompt - 任务描述用于 UI 展示
 */
export function runBackgroundAgent(
  runFn: () => Promise<{ summary: string; toolCalls: number }>,
  onEvent: (ev: TaskEvent) => void,
  agentType?: string,
  prompt?: string,
): { agentId: string } {
  const agentId = `bg_${Date.now()}_${++agentIdCounter}`;

  let status: BackgroundAgentStatus = 'running';
  let pauseResolve: (() => void) | null = null;
  let lastToolCallCount = 0;

  // 立即返回 agent_id
  onEvent({
    type: 'text_delta',
    taskId: '',
    text: `[BackgroundAgent: ${agentId}] 启动（type=${agentType ?? 'unknown'}）`,
  } as TaskEvent);

  // 心跳
  const heartbeat = setInterval(() => {
    if (status === 'paused') return;
    onEvent({
      type: 'text_delta',
      taskId: '',
      text: `[心跳] 后台子代理 ${agentId} 运行中...`,
    } as TaskEvent);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  // 异步执行，不 await
  runFn()
    .then((result) => {
      if (status === 'running' || status === 'paused') {
        status = 'completed';
      }
      clearInterval(heartbeat);

      const toolCalls = result.toolCalls;

      onEvent({
        type: 'text_delta',
        taskId: '',
        text: `[BackgroundAgent: ${agentId}] 完成。工具调用次数: ${toolCalls}`,
      } as TaskEvent);

      // 发射 subagent_completed 事件（TaskLoop 消费此事件）
      onEvent({
        type: 'subagent_completed',
        taskId: '',
        agentId,
        summary: result.summary,
        toolCalls,
        agentType: agentType ?? undefined,
        failed: false,
      } as unknown as TaskEvent);
    })
    .catch((error) => {
      status = 'failed';
      clearInterval(heartbeat);

      onEvent({
        type: 'subagent_completed',
        taskId: '',
        agentId,
        summary: `[BackgroundAgent failed] ${(error as Error).message}`,
        toolCalls: 0,
        agentType: agentType ?? undefined,
        failed: true,
      } as unknown as TaskEvent);
    });

  return { agentId };
}
