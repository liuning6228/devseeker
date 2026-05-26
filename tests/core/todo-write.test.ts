/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * todo_write 工具单测（W7e4）
 */

import { describe, it, expect } from 'vitest';
import { TodoWriteTool, validateArgs, diffSummary } from '../../src/core/tools/todo_write.js';
import type { TodoItem } from '../../src/shared/protocol.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

function makeTodo(partial?: Partial<TodoItem>): TodoItem {
  return {
    id: 'abc',
    content: 'Do something',
    status: 'PENDING',
    ...partial,
  };
}

function ctx(signal = new AbortController().signal) {
  return {
    workspaceRoot: '/tmp/ws',
    signal,
    taskId: 't1',
    toolCallId: 'c1',
  };
}

describe('validateArgs', () => {
  it('accepts valid todos', () => {
    expect(
      validateArgs({ todos: [makeTodo(), makeTodo({ id: 'def', status: 'IN_PROGRESS' })] }),
    ).toBeUndefined();
  });

  it('rejects non-array todos', () => {
    expect(validateArgs({ todos: 'nope' } as unknown as { todos: TodoItem[] })).toMatch(/数组/);
  });

  it('rejects empty id', () => {
    expect(validateArgs({ todos: [makeTodo({ id: '' })] })).toMatch(/id 不能为空/);
  });

  it('rejects empty content', () => {
    expect(validateArgs({ todos: [makeTodo({ content: '  ' })] })).toMatch(/content 不能为空/);
  });

  it('rejects invalid status', () => {
    expect(validateArgs({ todos: [makeTodo({ status: 'DONE' as TodoItem['status'] })] })).toMatch(
      /PENDING/,
    );
  });

  it('rejects duplicate ids', () => {
    expect(
      validateArgs({ todos: [makeTodo(), makeTodo()] }),
    ).toMatch(/重复 id/);
  });
});

describe('diffSummary', () => {
  it('detects additions', () => {
    expect(diffSummary([], [makeTodo()])).toBe('+1');
  });

  it('detects removals', () => {
    expect(diffSummary([makeTodo()], [])).toBe('-1');
  });

  it('detects changes', () => {
    expect(
      diffSummary([makeTodo()], [makeTodo({ status: 'COMPLETE' })]),
    ).toBe('~1');
  });

  it('detects unchanged', () => {
    expect(diffSummary([makeTodo()], [makeTodo()])).toBe('1 unchanged');
  });

  it('handles mixed', () => {
    const prev = [makeTodo({ id: 'a' }), makeTodo({ id: 'b', content: 'old' })];
    const next = [makeTodo({ id: 'a', status: 'COMPLETE' }), makeTodo({ id: 'c' })];
    expect(diffSummary(prev, next)).toBe('+1, -1, ~1');
  });
});

describe('TodoWriteTool', () => {
  it('writes and returns diff summary', async () => {
    const stored: TodoItem[] = [];
    const deps = {
      getTodos: () => [...stored],
      setTodos: (todos: TodoItem[]) => {
        stored.length = 0;
        stored.push(...todos);
      },
    };
    const t = new TodoWriteTool(deps);
    const r = await t.execute(
      { todos: [makeTodo(), makeTodo({ id: 'x1', content: 'Step 2', status: 'PENDING' })] },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/\+2/);
    expect(deps.getTodos()).toHaveLength(2);
  });

  it('rejects invalid args', async () => {
    const deps = { getTodos: () => [] as TodoItem[], setTodos: () => {} };
    const t = new TodoWriteTool(deps);
    const r = await t.execute(
      { todos: [makeTodo(), makeTodo()] } as { todos: TodoItem[] },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('respects aborted signal', async () => {
    const deps = { getTodos: () => [] as TodoItem[], setTodos: () => {} };
    const t = new TodoWriteTool(deps);
    const ac = new AbortController();
    ac.abort();
    const r = await t.execute({ todos: [makeTodo()] }, ctx(ac.signal));
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TASK_LOOP_ABORTED);
  });

  it('updates existing todos', async () => {
    const stored: TodoItem[] = [makeTodo()];
    const deps = {
      getTodos: () => [...stored],
      setTodos: (todos: TodoItem[]) => {
        stored.length = 0;
        stored.push(...todos);
      },
    };
    const t = new TodoWriteTool(deps);
    const r = await t.execute(
      { todos: [makeTodo({ status: 'COMPLETE' })] },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/~1/);
    expect(deps.getTodos()[0].status).toBe('COMPLETE');
  });

  it('clears all todos with empty array', async () => {
    const stored: TodoItem[] = [makeTodo()];
    const deps = {
      getTodos: () => [...stored],
      setTodos: (todos: TodoItem[]) => {
        stored.length = 0;
        stored.push(...todos);
      },
    };
    const t = new TodoWriteTool(deps);
    const r = await t.execute({ todos: [] }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/-1/);
    expect(deps.getTodos()).toHaveLength(0);
  });
});
