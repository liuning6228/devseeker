/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * reducer · 卡片契约测试（docs/card-contract-optimization-plan.md P0 组）
 *
 * 覆盖：
 * - P0-1 轮次收敛：TURN_FINALIZE 按 streamId 写回正确消息（多轮不丢文本 / 不写错消息）
 * - P0-2 审批身份路由：多审批并发不覆盖；按 toolCallId / requestId 精确清除；CLEAR_ALL
 * - P0-3 终态收敛：task_end(aborted) 把 pending/running 工具卡收敛为错误态并清空待审批
 */

import { describe, it, expect } from 'vitest';
import { reducer, initialState, type AppState, type ToolCallPart } from '../reducer';
import type { ApprovalRequestPayload } from '../../protocol';
import type { TaskEvent } from '../../protocol';

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

function approvalPayload(requestId: string, toolCallId: string, extra: Partial<ApprovalRequestPayload> = {}): ApprovalRequestPayload {
  return {
    requestId,
    toolCallId,
    toolName: extra.toolName ?? 'read_file',
    safetyLevel: extra.safetyLevel ?? 'read_only',
    reason: extra.reason ?? '按 ToolSafetyLevel.read_only 默认策略',
    argsPreview: extra.argsPreview ?? '{"file_path":"a.ts"}',
    ...extra,
  };
}

describe('P0-1 · TURN_FINALIZE 轮次收敛', () => {
  it('turn_start 给消息写入 streamId，TURN_FINALIZE 按 sid 写回该消息', () => {
    let s = apply([
      { type: 'turn_start', taskId: 't1', turn: 1 },
      { type: 'turn_start', taskId: 't1', turn: 2 },
    ]);
    s = reducer(s, { type: 'TURN_FINALIZE', streamId: 'stream-t1-t1', text: '第一轮文本' });
    s = reducer(s, { type: 'TURN_FINALIZE', streamId: 'stream-t1-t2', text: '第二轮文本' });

    expect(s.messages).toHaveLength(2);
    expect(s.messages[0].streamId).toBe('stream-t1-t1');
    expect(s.messages[0].parts[0]).toMatchObject({ kind: 'text', text: '第一轮文本', isStreaming: false });
    expect(s.messages[1].parts[0]).toMatchObject({ kind: 'text', text: '第二轮文本', isStreaming: false });
  });

  it('未知 streamId 回退到最后一条 assistant 文本 part（兼容旧路径）', () => {
    const s0 = apply([{ type: 'turn_start', taskId: 't1', turn: 1 }]);
    const s1 = reducer(s0, { type: 'TURN_FINALIZE', streamId: 'ghost-sid', text: '回退文本' });
    expect(s1.messages[0].parts[0]).toMatchObject({ kind: 'text', text: '回退文本', isStreaming: false });
  });

  it('中间轮文本在 task_end 后仍然保留（finalizeStreaming 不清空已写回文本）', () => {
    let s = apply([
      { type: 'turn_start', taskId: 't1', turn: 1 },
      { type: 'turn_start', taskId: 't1', turn: 2 },
    ]);
    s = reducer(s, { type: 'TURN_FINALIZE', streamId: 'stream-t1-t1', text: '中间轮结论' });
    s = reducer(s, { type: 'TURN_FINALIZE', streamId: 'stream-t1-t2', text: '最终结论' });
    s = apply([{ type: 'task_end', taskId: 't1', reason: 'completed' }], s);

    expect(s.messages[0].parts[0]).toMatchObject({ kind: 'text', text: '中间轮结论', isStreaming: false });
    expect(s.messages[1].parts[0]).toMatchObject({ kind: 'text', text: '最终结论', isStreaming: false });
  });
});

describe('P0-2 · 审批身份路由（多请求不串扰）', () => {
  it('两条并发审批各自入 map，互不覆盖', () => {
    let s = apply([
      { type: 'turn_start', taskId: 't1', turn: 1 },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c1', name: 'read_file' },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c2', name: 'search_web' },
    ]);
    s = reducer(s, { type: 'APPROVAL_REQUEST', payload: approvalPayload('r1', 'c1', { toolName: 'read_file' }) });
    s = reducer(s, { type: 'APPROVAL_REQUEST', payload: approvalPayload('r2', 'c2', { toolName: 'search_web', safetyLevel: 'network' }) });

    expect(Object.keys(s.pendingApprovals)).toEqual(['c1', 'c2']);
    expect(s.pendingApprovals['c1'].requestId).toBe('r1');
    expect(s.pendingApprovals['c2'].requestId).toBe('r2');
  });

  it('APPROVAL_CLEAR 按 toolCallId 精确移除，不影响其他待审批', () => {
    let s = apply([{ type: 'turn_start', taskId: 't1', turn: 1 }]);
    s = reducer(s, { type: 'APPROVAL_REQUEST', payload: approvalPayload('r1', 'c1') });
    s = reducer(s, { type: 'APPROVAL_REQUEST', payload: approvalPayload('r2', 'c2') });
    s = reducer(s, { type: 'APPROVAL_CLEAR', toolCallId: 'c1' });

    expect(Object.keys(s.pendingApprovals)).toEqual(['c2']);
    expect(s.approvalRequest?.requestId).toBe('r2');
  });

  it('APPROVAL_CLEAR 也支持按 requestId 移除（非聊天视图覆盖层路径）', () => {
    let s = apply([{ type: 'turn_start', taskId: 't1', turn: 1 }]);
    s = reducer(s, { type: 'APPROVAL_REQUEST', payload: approvalPayload('r1', 'c1') });
    s = reducer(s, { type: 'APPROVAL_REQUEST', payload: approvalPayload('r2', 'c2') });
    s = reducer(s, { type: 'APPROVAL_CLEAR', requestId: 'r1' });

    expect(Object.keys(s.pendingApprovals)).toEqual(['c2']);
  });

  it('APPROVAL_CLEAR_ALL 清空全部', () => {
    let s = apply([{ type: 'turn_start', taskId: 't1', turn: 1 }]);
    s = reducer(s, { type: 'APPROVAL_REQUEST', payload: approvalPayload('r1', 'c1') });
    s = reducer(s, { type: 'APPROVAL_REQUEST', payload: approvalPayload('r2', 'c2') });
    s = reducer(s, { type: 'APPROVAL_CLEAR_ALL' });

    expect(s.pendingApprovals).toEqual({});
    expect(s.approvalRequest).toBeUndefined();
  });

  it('重复推送同一 requestId 幂等（不产生重复项）', () => {
    let s = apply([{ type: 'turn_start', taskId: 't1', turn: 1 }]);
    const p = approvalPayload('r1', 'c1');
    s = reducer(s, { type: 'APPROVAL_REQUEST', payload: p });
    s = reducer(s, { type: 'APPROVAL_REQUEST', payload: p });
    expect(Object.keys(s.pendingApprovals)).toEqual(['c1']);
  });
});

describe('P1 · 变更汇总补源（H8）与拒绝回执（H4）', () => {
  it('aggregateChangedFiles：写工具成功但无 diff → 条目带 noDiff 标记（不再漏项）', async () => {
    const { aggregateChangedFiles } = await import('../../components/ChangeSummary');
    const items = aggregateChangedFiles([
      {
        parts: [
          { kind: 'tool', name: 'write_file', status: 'success', argsPreview: '{"file_path":"src/a.ts"}' },
          { kind: 'tool', name: 'read_file', status: 'success', argsPreview: '{"file_path":"src/b.ts"}' },
          { kind: 'tool', name: 'write_file', status: 'error', argsPreview: '{"file_path":"src/c.ts"}' },
        ],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ relPath: 'src/a.ts', noDiff: true });
  });

  it('aggregateChangedFiles：有 diff 的写工具走原逻辑（不产生 noDiff）', async () => {
    const { aggregateChangedFiles } = await import('../../components/ChangeSummary');
    const items = aggregateChangedFiles([
      {
        parts: [
          {
            kind: 'tool',
            name: 'write_file',
            status: 'success',
            argsPreview: '{"file_path":"src/a.ts"}',
            diff: {
              toolCallId: 'c1',
              toolName: 'write_file',
              relPath: 'src/a.ts',
              added: 3,
              removed: 1,
              unified: '@@ -1 +1 @@\n-a\n+b',
            },
          },
        ],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ relPath: 'src/a.ts', added: 3, removed: 1 });
    expect(items[0].noDiff).toBeUndefined();
  });

  it('REJECT_RESULT 失败：写入 revertState 原因并撤回“已拒绝”声明', () => {
    let s = apply([
      { type: 'turn_start', taskId: 't1', turn: 1 },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c1', name: 'write_file' },
    ]);
    s = reducer(s, {
      type: 'TOOL_DIFF',
      payload: {
        toolCallId: 'c1',
        toolName: 'write_file',
        relPath: 'src/a.ts',
        added: 3,
        removed: 1,
        unified: '@@ -1 +1 @@\n-a\n+b',
      },
    });
    s = reducer(s, { type: 'REJECT_FILE', relPath: 'src/a.ts' });
    expect(s.rejectedFiles).toContain('src/a.ts');

    s = reducer(s, {
      type: 'REJECT_RESULT',
      relPath: 'src/a.ts',
      ok: false,
      message: '该文件没有可用的 checkpoint：内容未回滚',
    });

    expect(s.rejectedFiles).not.toContain('src/a.ts');
    expect(findTool(s, 'c1')?.revertState).toMatchObject({
      ok: false,
      message: '该文件没有可用的 checkpoint：内容未回滚',
    });
  });

  it('REJECT_RESULT 成功：保留“已拒绝”并标记 revertState.ok', () => {
    let s = apply([
      { type: 'turn_start', taskId: 't1', turn: 1 },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c1', name: 'write_file' },
    ]);
    s = reducer(s, {
      type: 'TOOL_DIFF',
      payload: {
        toolCallId: 'c1',
        toolName: 'write_file',
        relPath: 'src/a.ts',
        added: 1,
        removed: 1,
        unified: '@@ -1 +1 @@\n-a\n+b',
      },
    });
    s = reducer(s, { type: 'REJECT_FILE', relPath: 'src/a.ts' });
    s = reducer(s, { type: 'REJECT_RESULT', relPath: 'src/a.ts', ok: true });

    expect(s.rejectedFiles).toContain('src/a.ts');
    expect(findTool(s, 'c1')?.revertState?.ok).toBe(true);
  });

  it('TOOL_DIFF：已接受文件再次被修改 → 清除 accept 标记（按钮可重新出现）', () => {
    let s = apply([
      { type: 'turn_start', taskId: 't1', turn: 1 },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c1', name: 'write_file' },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c2', name: 'write_file' },
    ]);
    const diff = {
      toolCallId: 'c1',
      toolName: 'write_file',
      relPath: 'src/a.ts',
      added: 3,
      removed: 1,
      unified: '@@ -1 +1 @@\n-a\n+b',
    };
    s = reducer(s, { type: 'TOOL_DIFF', payload: diff });
    s = reducer(s, { type: 'ACCEPT_FILE', relPath: 'src/a.ts' });
    expect(s.acceptedFiles).toContain('src/a.ts');

    // 第二次修改同一文件：新 diff 到达必须清除旧“已接受”，否则按钮不再出现
    s = reducer(s, {
      type: 'TOOL_DIFF',
      payload: { ...diff, toolCallId: 'c2', added: 1, removed: 0 },
    });
    expect(s.acceptedFiles).not.toContain('src/a.ts');
  });

  it('TOOL_DIFF：已拒绝文件再次被修改 → 清除 reject 标记', () => {
    let s = apply([
      { type: 'turn_start', taskId: 't1', turn: 1 },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c1', name: 'write_file' },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c2', name: 'write_file' },
    ]);
    const diff = {
      toolCallId: 'c1',
      toolName: 'write_file',
      relPath: 'src/a.ts',
      added: 1,
      removed: 1,
      unified: '@@ -1 +1 @@\n-a\n+b',
    };
    s = reducer(s, { type: 'TOOL_DIFF', payload: diff });
    s = reducer(s, { type: 'REJECT_FILE', relPath: 'src/a.ts' });
    expect(s.rejectedFiles).toContain('src/a.ts');

    s = reducer(s, {
      type: 'TOOL_DIFF',
      payload: { ...diff, toolCallId: 'c2' },
    });
    expect(s.rejectedFiles).not.toContain('src/a.ts');
  });

  it('aggregateChangedFiles：回滚后再次修改 → reverted 重置（回到待处理）', async () => {
    const { aggregateChangedFiles } = await import('../../components/ChangeSummary');
    const items = aggregateChangedFiles([
      {
        parts: [
          {
            kind: 'tool',
            name: 'write_file',
            status: 'success',
            diff: {
              toolCallId: 'c1',
              toolName: 'write_file',
              relPath: 'src/a.ts',
              added: 2,
              removed: 1,
              unified: '',
            },
            revertState: { ok: true },
          },
          {
            kind: 'tool',
            name: 'write_file',
            status: 'success',
            diff: {
              toolCallId: 'c2',
              toolName: 'write_file',
              relPath: 'src/a.ts',
              added: 1,
              removed: 0,
              unified: '',
            },
          },
        ],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].reverted).toBe(false);
    expect(items[0].edits).toBe(2);
  });

  it('aggregateChangedFiles：先无 diff 兜底条目、后捕获到 diff → 清除 noDiff 恢复可接受', async () => {
    const { aggregateChangedFiles } = await import('../../components/ChangeSummary');
    const items = aggregateChangedFiles([
      {
        parts: [
          { kind: 'tool', name: 'write_file', status: 'success', argsPreview: '{"file_path":"src/a.ts"}' },
          {
            kind: 'tool',
            name: 'write_file',
            status: 'success',
            argsPreview: '{"file_path":"src/a.ts"}',
            diff: {
              toolCallId: 'c2',
              toolName: 'write_file',
              relPath: 'src/a.ts',
              added: 1,
              removed: 0,
              unified: '',
              checkpointId: 'cp-2',
            },
          },
        ],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].noDiff).toBeUndefined();
    expect(items[0].latestCheckpointId).toBe('cp-2');
  });

  it('TOOL_DIFF：无对应工具卡（restore-* 恢复推送）→ 落入 restoredDiffs，不丢弃', () => {
    let s = apply([
      { type: 'turn_start', taskId: 't1', turn: 1 },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c1', name: 'read_file' },
    ]);
    s = reducer(s, {
      type: 'TOOL_DIFF',
      payload: {
        toolCallId: 'restore-s1-1',
        toolName: 'write_file',
        relPath: 'src/a.ts',
        added: 3,
        removed: 1,
        unified: '@@ -1 +1 @@\n-a\n+b',
        checkpointId: 'cp-restore',
      },
    });

    expect(s.restoredDiffs['src/a.ts']).toMatchObject({
      relPath: 'src/a.ts',
      added: 3,
      removed: 1,
      checkpointId: 'cp-restore',
    });
    // 不注入消息流：不产生幽灵工具卡
    expect(findTool(s, 'restore-s1-1')).toBeUndefined();
  });

  it('TOOL_DIFF：非恢复推送（真实 id）无对应工具卡 → 静默忽略，不污染 restoredDiffs', () => {
    let s = apply([
      { type: 'turn_start', taskId: 't1', turn: 1 },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c1', name: 'read_file' },
    ]);
    // 迟到/陈旧的旧会话 diff（如任务中止后 in-flight 推送）不得混入当前会话清单
    s = reducer(s, {
      type: 'TOOL_DIFF',
      payload: {
        toolCallId: 'call_stale_001',
        toolName: 'write_file',
        relPath: 'src/old.ts',
        added: 9,
        removed: 9,
        unified: '',
      },
    });
    expect(s.restoredDiffs).toEqual({});
  });

  it('HISTORY_RESET：清空 restoredDiffs（切换会话后由宿主重推新快照）', () => {
    let s = reducer(initialState, {
      type: 'TOOL_DIFF',
      payload: {
        toolCallId: 'restore-s1-1',
        toolName: 'write_file',
        relPath: 'src/a.ts',
        added: 1,
        removed: 0,
        unified: '',
      },
    });
    expect(Object.keys(s.restoredDiffs)).toHaveLength(1);

    s = reducer(s, { type: 'HISTORY_RESET', messages: [], sessionId: 's2' });
    expect(s.restoredDiffs).toEqual({});
  });

  it('aggregateChangedFiles：restoredDiffs 并入清单，真实 diff 在其上累加', async () => {
    const { aggregateChangedFiles } = await import('../../components/ChangeSummary');
    const items = aggregateChangedFiles(
      [
        {
          parts: [
            {
              kind: 'tool',
              name: 'write_file',
              status: 'success',
              diff: {
                toolCallId: 'c9',
                toolName: 'write_file',
                relPath: 'src/a.ts',
                added: 1,
                removed: 0,
                unified: '',
                checkpointId: 'cp-new',
              },
            },
          ],
        },
      ],
      {
        'src/a.ts': {
          toolCallId: 'restore-s1-1',
          toolName: 'write_file',
          relPath: 'src/a.ts',
          added: 3,
          removed: 1,
          unified: '',
          checkpointId: 'cp-restore',
        },
        'src/b.ts': {
          toolCallId: 'restore-s1-2',
          toolName: 'write_file',
          relPath: 'src/b.ts',
          added: 2,
          removed: 2,
          unified: '',
        },
      },
    );

    expect(items).toHaveLength(2);
    const a = items.find((f) => f.relPath === 'src/a.ts')!;
    expect(a).toMatchObject({ added: 4, removed: 1, edits: 2, latestCheckpointId: 'cp-new' });
    const b = items.find((f) => f.relPath === 'src/b.ts')!;
    expect(b).toMatchObject({ added: 2, removed: 2, edits: 1 });
  });
});

describe('P0-3 · task_end 终态收敛', () => {
  it('aborted：pending 与 running 工具卡统一收敛为错误态 + 清空待审批', () => {
    let s = apply([
      { type: 'turn_start', taskId: 't1', turn: 1 },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c1', name: 'bash' },
      { type: 'tool_exec_start', taskId: 't1', toolCallId: 'c1', name: 'bash', args: {}, startTime: 1 },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c2', name: 'read_file' },
    ]);
    s = reducer(s, { type: 'APPROVAL_REQUEST', payload: approvalPayload('r1', 'c2') });
    expect(findTool(s, 'c2')?.status).toBe('running');

    s = apply([{ type: 'task_end', taskId: 't1', reason: 'aborted' }], s);

    const c1 = findTool(s, 'c1');
    expect(c1?.status).toBe('error');
    expect(c1?.errorCode).toBe('TASK.LOOP.ABORTED');
    expect(c1?.contentPreview).toContain('已中止');

    const c2 = findTool(s, 'c2');
    expect(c2?.status).toBe('error');
    expect(c2?.errorCode).toBe('TASK.LOOP.ABORTED');

    expect(s.pendingApprovals).toEqual({});
    expect(s.approvalRequest).toBeUndefined();
    expect(s.taskStatus).toBe('idle');
  });

  it('max_turns：收敛码为 TASK.LOOP.INFINITE', () => {
    let s = apply([
      { type: 'turn_start', taskId: 't1', turn: 1 },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c1', name: 'read_file' },
    ]);
    s = apply([{ type: 'task_end', taskId: 't1', reason: 'max_turns' }], s);
    expect(findTool(s, 'c1')?.errorCode).toBe('TASK.LOOP.INFINITE');
  });

  it('completed：不把已有终态卡改坏，也不残留 pending 卡', () => {
    let s = apply([
      { type: 'turn_start', taskId: 't1', turn: 1 },
      { type: 'tool_start', taskId: 't1', toolCallId: 'c1', name: 'read_file' },
      { type: 'tool_exec_start', taskId: 't1', toolCallId: 'c1', name: 'read_file', args: {}, startTime: 1 },
      { type: 'tool_exec_end', taskId: 't1', toolCallId: 'c1', name: 'read_file', ok: true, contentPreview: '', endTime: 2 },
    ]);
    s = apply([{ type: 'task_end', taskId: 't1', reason: 'completed' }], s);
    expect(findTool(s, 'c1')?.status).toBe('success');
  });
});
