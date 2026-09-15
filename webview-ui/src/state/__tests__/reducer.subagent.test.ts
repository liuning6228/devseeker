/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * reducer · subagent_event 单测（P0 · 子代理过程可见性）
 *
 * 覆盖：
 * - 子代理过程累积：start → 步骤 → 文本 → end
 * - 工具失败 → 步骤 error + 终态 ok:false
 * - 正文尾部截断（2000 字符上限）
 * - parentToolCallId 不存在时静默忽略
 * - 仅 UI 旁路：不新增消息、不污染主消息文本
 */

import { describe, it, expect } from 'vitest';
import { reducer, initialState, type AppState, type ToolCallPart } from '../reducer';
import type { SubagentProgressEvent, TaskEvent } from '../../protocol';

const CARD_ID = 'call-1';

function apply(events: TaskEvent[], base: AppState = initialState): AppState {
  let s = base;
  for (const event of events) s = reducer(s, { type: 'TASK_EVENT', event });
  return s;
}

function findTool(state: AppState, toolCallId: string): ToolCallPart | undefined {
  for (const msg of state.messages) {
    for (const p of msg.parts) {
      if (p.kind === 'tool' && p.toolCallId === toolCallId) return p;
    }
  }
  return undefined;
}

/** 模拟主会话中 Agent 工具卡片建立（tool_start → tool_exec_start） */
function baseEvents(): TaskEvent[] {
  return [
    { type: 'turn_start', taskId: 't1', turn: 1 },
    { type: 'tool_start', taskId: 't1', toolCallId: CARD_ID, name: 'Agent' },
    {
      type: 'tool_exec_start',
      taskId: 't1',
      toolCallId: CARD_ID,
      name: 'Agent',
      args: { subagent_type: 'Research' },
      startTime: 1,
    },
  ];
}

function subagentEvent(progress: SubagentProgressEvent, parentToolCallId = CARD_ID): TaskEvent {
  return {
    type: 'subagent_event',
    taskId: 't1',
    parentToolCallId,
    agentType: 'Research',
    progress,
  };
}

describe('reducer · subagent_event', () => {
  it('累积子代理过程：start → 步骤 → 文本 → end', () => {
    const s = apply([
      ...baseEvents(),
      subagentEvent({ type: 'subagent_start', agentType: 'Research', description: '调查认证', startTime: 1000, maxTurns: 15 }),
      subagentEvent({ type: 'subagent_tool_start', name: 'search_codebase', toolId: 'tc1' }),
      subagentEvent({ type: 'subagent_tool_end', name: 'search_codebase', toolId: 'tc1', ok: true }),
      subagentEvent({ type: 'subagent_text', text: '找到了 JWT 用法' }),
      subagentEvent({ type: 'subagent_end', ok: true, summary: '找到了 JWT 用法', toolCalls: 1 }),
    ]);

    const sub = findTool(s, CARD_ID)?.subagent;
    expect(sub).toBeDefined();
    expect(sub!.agentType).toBe('Research');
    expect(sub!.description).toBe('调查认证');
    expect(sub!.status).toBe('done');
    expect(sub!.steps).toEqual([{ name: 'search_codebase', toolId: 'tc1', status: 'done' }]);
    expect(sub!.textTail).toContain('找到了 JWT 用法');
    expect(sub!.summary).toBe('找到了 JWT 用法');
    expect(sub!.toolCalls).toBe(1);
    // P1：计时基准与预算回传
    expect(sub!.startTime).toBe(1000);
    expect(sub!.maxTurns).toBe(15);
  });

  it('步骤耗时与总耗时：tool_start 带 startTime，tool_end 回填 durationMs，end 回填总耗时', () => {
    const s = apply([
      ...baseEvents(),
      subagentEvent({ type: 'subagent_start', agentType: 'Research', description: 'x', startTime: 1000 }),
      subagentEvent({ type: 'subagent_tool_start', name: 'bash', toolId: 'tc1', startTime: 1100 }),
      subagentEvent({ type: 'subagent_tool_end', name: 'bash', toolId: 'tc1', ok: true, durationMs: 250 }),
      subagentEvent({ type: 'subagent_end', ok: true, summary: 'done', toolCalls: 1, durationMs: 4200 }),
    ]);

    const sub = findTool(s, CARD_ID)!.subagent!;
    expect(sub.startTime).toBe(1000);
    expect(sub.steps[0]).toMatchObject({ startTime: 1100, durationMs: 250, status: 'done' });
    expect(sub.durationMs).toBe(4200);
  });

  it('工具失败 → 步骤 error + 终态 ok:false', () => {
    const s = apply([
      ...baseEvents(),
      subagentEvent({ type: 'subagent_tool_start', name: 'bash', toolId: 'tc2' }),
      subagentEvent({ type: 'subagent_tool_end', name: 'bash', toolId: 'tc2', ok: false }),
      subagentEvent({ type: 'subagent_end', ok: false, summary: '测试失败', toolCalls: 1 }),
    ]);

    const sub = findTool(s, CARD_ID)?.subagent;
    expect(sub!.steps).toEqual([{ name: 'bash', toolId: 'tc2', status: 'error' }]);
    expect(sub!.status).toBe('error');
    expect(sub!.summary).toBe('测试失败');
  });

  it('正文尾部截断保留 2000 字符', () => {
    const s = apply([
      ...baseEvents(),
      subagentEvent({ type: 'subagent_text', text: 'x'.repeat(2500) }),
    ]);
    expect(findTool(s, CARD_ID)!.subagent!.textTail).toHaveLength(2000);
  });

  it('不变量：卡片只能由 tool_start 建立，tool_exec_start 不会补建卡片', () => {
    // 回归护栏：CVW 硬验证路径曾漏发 tool_start，导致卡片永不创建、
    // 其 tool_exec_start/subagent_event 全部无处归位（静默丢弃）。
    const s = apply([
      { type: 'turn_start', taskId: 't1', turn: 1 },
      { type: 'tool_exec_start', taskId: 't1', toolCallId: 'ghost', name: 'Agent', args: {}, startTime: 1 },
    ]);
    expect(findTool(s, 'ghost')).toBeUndefined();
  });

  it('parentToolCallId 不存在时静默忽略（不新增卡片、不崩溃）', () => {
    const s0 = apply(baseEvents());
    const s1 = apply(
      [subagentEvent({ type: 'subagent_start', agentType: 'Ghost', description: '', startTime: 1 }, 'ghost-id')],
      s0,
    );
    expect(findTool(s1, CARD_ID)?.subagent).toBeUndefined();
    expect(findTool(s1, 'ghost-id')).toBeUndefined();
  });

  it('仅 UI 旁路：不新增消息、不污染主消息文本', () => {
    const before = apply(baseEvents());
    const s = apply(
      [
        subagentEvent({ type: 'subagent_text', text: '子代理内部文本' }),
        subagentEvent({ type: 'subagent_end', ok: true, summary: '子代理内部文本', toolCalls: 0 }),
      ],
      before,
    );

    expect(s.messages.length).toBe(before.messages.length);
    const lastMsg = s.messages[s.messages.length - 1];
    const textPart = lastMsg.parts.find((p) => p.kind === 'text');
    expect(textPart && textPart.kind === 'text' ? textPart.text : undefined).toBe('');
  });
});
