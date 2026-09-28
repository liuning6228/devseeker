/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Subagent 事件桥单测（P0 · 子代理过程可见性 + P1 耗时/ETA 数据）
 *
 * 覆盖：
 * - 无 emit 时整体 no-op（不抛错、零副作用）
 * - 首帧 subagent_start（含 parentToolCallId 归位信息 / startTime / maxTurns）
 * - 工具步骤映射 + 步骤耗时（durationMs = endTime - startTime）
 * - 文本合并：end() 前强制 flush，顺序在 subagent_end 之前
 * - tool_exec_start 前先 flush 缓冲文本，保证 UI 顺序
 * - end() 幂等：重复调用只发一次终态，且携带总耗时
 * - 后台完成（subagent_completed）→ subagent_end 映射
 * - usage → subagent_usage 映射
 */

import { describe, it, expect } from 'vitest';
import { createSubagentEventBridge } from '../../src/core/subagent/event-bridge.js';
import type { SubagentProgressEvent, TaskEvent } from '../../src/shared/protocol.js';

type SubagentTaskEvent = Extract<TaskEvent, { type: 'subagent_event' }>;

function setup(opts: { maxTurns?: number } = {}) {
  const events: TaskEvent[] = [];
  const bridge = createSubagentEventBridge({
    taskId: 'task-1',
    parentToolCallId: 'call-1',
    agentType: 'Research',
    description: '调查一下',
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    emit: (ev) => events.push(ev),
  });
  const subEvents = (): SubagentTaskEvent[] =>
    events.filter((e): e is SubagentTaskEvent => e.type === 'subagent_event');
  const progress = (): SubagentProgressEvent[] => subEvents().map((e) => e.progress);
  return { events, bridge, subEvents, progress };
}

describe('createSubagentEventBridge', () => {
  it('无 emit 时整体 no-op，不抛错', () => {
    const bridge = createSubagentEventBridge({
      taskId: 't',
      parentToolCallId: 'c',
      agentType: 'Browser',
      description: 'd',
    });
    expect(() => {
      bridge.onEvent({ type: 'text_delta', taskId: 't', text: 'hi' });
      bridge.onEvent({
        type: 'tool_exec_end',
        taskId: 't',
        toolCallId: 'x',
        name: 'search_web',
        ok: true,
        contentPreview: '',
        endTime: 1,
      });
      bridge.end(true, 'done', 1);
    }).not.toThrow();
    bridge.dispose();
  });

  it('首帧 subagent_start：携带 taskId / parentToolCallId / agentType / startTime', () => {
    const { subEvents, progress } = setup({ maxTurns: 15 });
    expect(subEvents()).toHaveLength(1);
    expect(subEvents()[0]).toMatchObject({
      type: 'subagent_event',
      taskId: 'task-1',
      parentToolCallId: 'call-1',
      agentType: 'Research',
    });
    const first = progress()[0];
    expect(first).toMatchObject({
      type: 'subagent_start',
      agentType: 'Research',
      description: '调查一下',
      maxTurns: 15,
    });
    expect(typeof (first as Extract<SubagentProgressEvent, { type: 'subagent_start' }>).startTime).toBe('number');
  });

  it('未提供 maxTurns 时 subagent_start 不含该字段', () => {
    const { progress } = setup();
    expect(progress()[0]).not.toHaveProperty('maxTurns');
  });

  it('工具步骤映射 + 耗时：tool_exec_start/end → startTime / durationMs', () => {
    const { bridge, progress } = setup();
    bridge.onEvent({
      type: 'tool_exec_start',
      taskId: 't',
      toolCallId: 'tc1',
      name: 'search_codebase',
      args: {},
      startTime: 1000,
    });
    bridge.onEvent({
      type: 'tool_exec_end',
      taskId: 't',
      toolCallId: 'tc1',
      name: 'search_codebase',
      ok: true,
      contentPreview: '',
      endTime: 1250,
    });
    const p = progress();
    expect(p[0]).toMatchObject({ type: 'subagent_start' });
    expect(p[1]).toEqual({
      type: 'subagent_tool_start',
      name: 'search_codebase',
      toolId: 'tc1',
      startTime: 1000,
    });
    expect(p[2]).toEqual({
      type: 'subagent_tool_end',
      name: 'search_codebase',
      toolId: 'tc1',
      ok: true,
      durationMs: 250,
    });
    bridge.dispose();
  });

  it('未配对 start 的 tool_exec_end 不带 durationMs（不产生负数/NaN）', () => {
    const { bridge, progress } = setup();
    bridge.onEvent({
      type: 'tool_exec_end',
      taskId: 't',
      toolCallId: 'orphan',
      name: 'bash',
      ok: false,
      contentPreview: '',
      endTime: 5,
    });
    const end = progress().find((p) => p.type === 'subagent_tool_end');
    expect(end).toEqual({ type: 'subagent_tool_end', name: 'bash', toolId: 'orphan', ok: false });
    bridge.dispose();
  });

  it('文本合并：多次 text_delta 合并，end() 强制 flush 且顺序在 subagent_end 之前', () => {
    const { bridge, progress } = setup();
    bridge.onEvent({ type: 'text_delta', taskId: 't', text: 'Hello ' });
    bridge.onEvent({ type: 'text_delta', taskId: 't', text: 'World' });
    // 100ms 合并窗口未到：缓冲尚未发出
    expect(progress()).toHaveLength(1);
    bridge.end(true, 'Hello World', 3);

    const p = progress();
    expect(p[0]).toMatchObject({ type: 'subagent_start' });
    expect(p[1]).toEqual({ type: 'subagent_text', text: 'Hello World' });
    expect(p[2]).toMatchObject({ type: 'subagent_end', ok: true, summary: 'Hello World', toolCalls: 3 });
    expect(typeof (p[2] as Extract<SubagentProgressEvent, { type: 'subagent_end' }>).durationMs).toBe('number');
  });

  it('tool_exec_start 前先 flush 缓冲文本，保证 UI 顺序', () => {
    const { bridge, progress } = setup();
    bridge.onEvent({ type: 'text_delta', taskId: 't', text: 'thinking...' });
    bridge.onEvent({
      type: 'tool_exec_start',
      taskId: 't',
      toolCallId: 'tc9',
      name: 'read_file',
      args: {},
      startTime: 1,
    });
    const p = progress();
    expect(p[1]).toEqual({ type: 'subagent_text', text: 'thinking...' });
    expect(p[2]).toMatchObject({ type: 'subagent_tool_start', name: 'read_file', toolId: 'tc9' });
    bridge.dispose();
  });

  it('end() 幂等：重复调用只发一次 subagent_end', () => {
    const { bridge, progress } = setup();
    bridge.end(true, 'a', 1);
    bridge.end(false, 'b', 2);
    const ends = progress().filter((p) => p.type === 'subagent_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ type: 'subagent_end', ok: true, summary: 'a', toolCalls: 1 });
  });

  it('后台部分完成（subagent_completed.partial）→ subagent_end 携带 partial 标记', () => {
    const { bridge, progress } = setup();
    bridge.onEvent({
      type: 'subagent_completed',
      taskId: 't',
      agentId: 'bg_3',
      summary: '⚠️ 达到轮次上限，部分成果',
      toolCalls: 8,
      failed: false,
      partial: true,
    });
    expect(progress().filter((p) => p.type === 'subagent_end')[0]).toMatchObject({
      type: 'subagent_end',
      ok: true,
      summary: '⚠️ 达到轮次上限，部分成果',
      toolCalls: 8,
      partial: true,
    });
    bridge.dispose();
  });

  it('后台完成事件（subagent_completed）映射为 subagent_end', () => {
    const { bridge, progress } = setup();
    bridge.onEvent({
      type: 'subagent_completed',
      taskId: 't',
      agentId: 'bg_1',
      summary: '后台完成',
      toolCalls: 4,
      failed: false,
    });
    expect(progress().filter((p) => p.type === 'subagent_end')[0]).toMatchObject({
      type: 'subagent_end',
      ok: true,
      summary: '后台完成',
      toolCalls: 4,
    });

    // 失败态（第二个桥）
    const failed = setup();
    failed.bridge.onEvent({
      type: 'subagent_completed',
      taskId: 't',
      agentId: 'bg_2',
      summary: 'boom',
      toolCalls: 0,
      failed: true,
    });
    expect(failed.progress().filter((p) => p.type === 'subagent_end')[0]).toMatchObject({
      type: 'subagent_end',
      ok: false,
      summary: 'boom',
      toolCalls: 0,
    });
  });

  it('usage → subagent_usage（成本记账用）', () => {
    const { bridge, progress } = setup();
    bridge.onEvent({
      type: 'usage',
      taskId: 't',
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 2,
    });
    expect(progress()).toContainEqual({
      type: 'subagent_usage',
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 2,
    });
    bridge.dispose();
  });

  it('turn_start → subagent_turn（UI 轮次进度口径）', () => {
    const { bridge, progress } = setup();
    bridge.onEvent({ type: 'turn_start', taskId: 't', turn: 1 });
    bridge.onEvent({ type: 'turn_start', taskId: 't', turn: 7 });
    const turns = progress().filter((p) => p.type === 'subagent_turn');
    expect(turns).toEqual([
      { type: 'subagent_turn', turn: 1 },
      { type: 'subagent_turn', turn: 7 },
    ]);
    bridge.dispose();
  });

  it('end(partial=true) → subagent_end 携带 partial 标记（部分完成）', () => {
    const { bridge, progress } = setup();
    bridge.end(true, '⚠️ 部分成果', 56, true);
    expect(progress().filter((p) => p.type === 'subagent_end')[0]).toMatchObject({
      type: 'subagent_end',
      ok: true,
      summary: '⚠️ 部分成果',
      toolCalls: 56,
      partial: true,
    });
    bridge.dispose();
  });

  it('end(partial 缺省) → subagent_end 不含 partial 字段（完全完成）', () => {
    const { bridge, progress } = setup();
    bridge.end(true, 'done', 3);
    expect(progress().filter((p) => p.type === 'subagent_end')[0]).not.toHaveProperty('partial');
    bridge.dispose();
  });
});
