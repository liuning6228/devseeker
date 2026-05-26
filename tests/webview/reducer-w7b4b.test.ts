/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Webview reducer W7b4b 新增 Action 单测
 *
 * 覆盖：
 * - ASK_QUESTION 写入 state.askQuestion
 * - ASK_CLEAR 清空 askQuestion
 * - TOOL_DIFF 写入对应 toolCallId 的 ToolCallPart.diff
 * - REVERT_RESULT ok=true/false 通过 checkpointId 找到 ToolCallPart 并写 revertState
 * - 未命中 checkpointId 不改变状态
 */

import { describe, it, expect } from 'vitest';
import {
  reducer,
  initialState,
  type AppState,
  type ToolCallPart,
} from '../../webview-ui/src/state/reducer.js';
import type {
  AskQuestionPayload,
  ToolDiffPayload,
} from '../../src/shared/protocol.js';

function stateWithTool(toolCallId: string, name = 'write_file'): AppState {
  // 先 TASK_EVENT tool_start 把 ToolCallPart 建起来
  let s = reducer(initialState, { type: 'USER_SEND', text: 'hi' });
  s = reducer(s, {
    type: 'TASK_EVENT',
    event: { type: 'task_start', taskId: 't1', userInput: 'hi' },
  });
  s = reducer(s, {
    type: 'TASK_EVENT',
    event: { type: 'turn_start', taskId: 't1', turn: 1 },
  });
  s = reducer(s, {
    type: 'TASK_EVENT',
    event: { type: 'tool_start', taskId: 't1', toolCallId, name },
  });
  return s;
}

function getToolPart(state: AppState, toolCallId: string): ToolCallPart | undefined {
  for (const msg of state.messages) {
    for (const p of msg.parts) {
      if (p.kind === 'tool' && p.toolCallId === toolCallId) return p;
    }
  }
  return undefined;
}

describe('reducer · ASK_QUESTION / ASK_CLEAR', () => {
  it('ASK_QUESTION sets askQuestion field', () => {
    const payload: AskQuestionPayload = {
      requestId: 'rid-1',
      questions: [
        {
          header: 'Lib',
          question: 'Which library?',
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        },
      ],
    };
    const s = reducer(initialState, { type: 'ASK_QUESTION', payload });
    expect(s.askQuestion).toEqual(payload);
  });

  it('ASK_CLEAR removes askQuestion', () => {
    const payload: AskQuestionPayload = {
      requestId: 'rid-2',
      questions: [
        {
          header: 'x',
          question: 'y?',
          options: [
            { label: 'a', description: 'a' },
            { label: 'b', description: 'b' },
          ],
        },
      ],
    };
    const s1 = reducer(initialState, { type: 'ASK_QUESTION', payload });
    expect(s1.askQuestion).toBeDefined();
    const s2 = reducer(s1, { type: 'ASK_CLEAR' });
    expect(s2.askQuestion).toBeUndefined();
  });
});

describe('reducer · TOOL_DIFF', () => {
  it('writes diff into matching ToolCallPart', () => {
    const s = stateWithTool('tc-1');
    const diff: ToolDiffPayload = {
      toolCallId: 'tc-1',
      checkpointId: 'cp-1',
      toolName: 'write_file',
      relPath: 'src/a.ts',
      unified: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b',
      added: 1,
      removed: 1,
    };
    const s2 = reducer(s, { type: 'TOOL_DIFF', payload: diff });
    const part = getToolPart(s2, 'tc-1');
    expect(part).toBeDefined();
    expect(part?.diff).toEqual(diff);
  });

  it('ignores TOOL_DIFF with unknown toolCallId', () => {
    const s = stateWithTool('tc-1');
    const diff: ToolDiffPayload = {
      toolCallId: 'does-not-exist',
      checkpointId: 'cp-x',
      toolName: 'write_file',
      relPath: 'x',
      unified: '',
      added: 0,
      removed: 0,
    };
    const s2 = reducer(s, { type: 'TOOL_DIFF', payload: diff });
    const part = getToolPart(s2, 'tc-1');
    expect(part?.diff).toBeUndefined();
  });
});

describe('reducer · REVERT_RESULT', () => {
  it('ok=true sets revertState.ok=true on tool matched by checkpointId', () => {
    let s = stateWithTool('tc-1');
    const diff: ToolDiffPayload = {
      toolCallId: 'tc-1',
      checkpointId: 'cp-9',
      toolName: 'write_file',
      relPath: 'a.ts',
      unified: '',
      added: 0,
      removed: 0,
    };
    s = reducer(s, { type: 'TOOL_DIFF', payload: diff });
    s = reducer(s, { type: 'REVERT_RESULT', checkpointId: 'cp-9', ok: true });
    const part = getToolPart(s, 'tc-1');
    expect(part?.revertState?.ok).toBe(true);
    expect(part?.revertState?.message).toBeUndefined();
  });

  it('ok=false carries message', () => {
    let s = stateWithTool('tc-2');
    const diff: ToolDiffPayload = {
      toolCallId: 'tc-2',
      checkpointId: 'cp-err',
      toolName: 'write_file',
      relPath: 'a.ts',
      unified: '',
      added: 0,
      removed: 0,
    };
    s = reducer(s, { type: 'TOOL_DIFF', payload: diff });
    s = reducer(s, {
      type: 'REVERT_RESULT',
      checkpointId: 'cp-err',
      ok: false,
      message: 'file locked',
    });
    const part = getToolPart(s, 'tc-2');
    expect(part?.revertState?.ok).toBe(false);
    expect(part?.revertState?.message).toBe('file locked');
  });

  it('unknown checkpointId → state unchanged (no revertState written)', () => {
    let s = stateWithTool('tc-3');
    const diff: ToolDiffPayload = {
      toolCallId: 'tc-3',
      checkpointId: 'cp-real',
      toolName: 'write_file',
      relPath: 'a.ts',
      unified: '',
      added: 0,
      removed: 0,
    };
    s = reducer(s, { type: 'TOOL_DIFF', payload: diff });
    const before = getToolPart(s, 'tc-3');
    const s2 = reducer(s, {
      type: 'REVERT_RESULT',
      checkpointId: 'cp-other',
      ok: true,
    });
    const after = getToolPart(s2, 'tc-3');
    expect(after?.revertState).toBeUndefined();
    expect(before?.revertState).toBeUndefined();
  });
});
