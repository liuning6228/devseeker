/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ask_user_question 工具单测（W7b4b DESIGN §M11.5）
 *
 * 覆盖：
 * - 参数校验：questions 长度 0 / 5 / 非数组 → TOOL_ARGS_INVALID
 * - options 长度 1 / 5、缺 label/description → TOOL_ARGS_INVALID
 * - 缺 header / question → TOOL_ARGS_INVALID
 * - bridge 正常回流 → ok=true 且 content 含 Q1/Selected
 * - bridge cancelled=true → ok=false errorCode=TASK_LOOP_ABORTED
 * - ctx.signal 预先 aborted → 立即 TASK_LOOP_ABORTED，不调用 bridge
 * - bridge 抛异常 → TOOL_EXEC_FAILED
 * - genRequestId 注入被调用；safetyLevel=external
 */

import { describe, it, expect } from 'vitest';
import {
  AskUserQuestionTool,
  type AskUserQuestionResponse,
} from '../../src/core/tools/ask_user_question.js';
import type { ToolContext } from '../../src/core/tools/types.js';
import type { AskQuestionItem } from '../../src/shared/protocol.js';
import { ErrorCodes } from '../../src/core/errors/index.js';

function mkCtx(signal?: AbortSignal): ToolContext {
  return {
    workspaceRoot: '/tmp',
    signal: signal ?? new AbortController().signal,
    taskId: 't',
    toolCallId: 'tc',
  };
}

function okQuestions(): AskQuestionItem[] {
  return [
    {
      header: 'Auth',
      question: 'Which auth method?',
      options: [
        { label: 'JWT', description: 'stateless' },
        { label: 'Session', description: 'stateful' },
      ],
    },
  ];
}

describe('AskUserQuestionTool metadata', () => {
  it('exposes name and external safetyLevel', () => {
    const tool = new AskUserQuestionTool({ bridge: async () => ({ answers: [] }) });
    expect(tool.name).toBe('ask_user_question');
    expect(tool.safetyLevel).toBe('external');
    expect(typeof tool.description).toBe('string');
  });
});

describe('AskUserQuestionTool validate', () => {
  const tool = new AskUserQuestionTool({ bridge: async () => ({ answers: [] }) });

  it('rejects non-array questions', async () => {
    const r = await tool.execute(
      // @ts-expect-error intentional
      { questions: 'bogus' },
      mkCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects empty questions array', async () => {
    const r = await tool.execute({ questions: [] }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects >4 questions', async () => {
    const q = okQuestions()[0]!;
    const r = await tool.execute({ questions: [q, q, q, q, q] }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects options with length 1', async () => {
    const qs: AskQuestionItem[] = [
      {
        header: 'h',
        question: 'q?',
        options: [{ label: 'only', description: 'x' }],
      },
    ];
    const r = await tool.execute({ questions: qs }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects options with length 5', async () => {
    const opt = { label: 'x', description: 'y' };
    const qs: AskQuestionItem[] = [
      { header: 'h', question: 'q?', options: [opt, opt, opt, opt, opt] },
    ];
    const r = await tool.execute({ questions: qs }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects missing header', async () => {
    const qs = [
      {
        header: undefined,
        question: 'q?',
        options: [
          { label: 'a', description: 'b' },
          { label: 'c', description: 'd' },
        ],
      },
    ] as unknown as AskQuestionItem[];
    const r = await tool.execute({ questions: qs }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects missing question text', async () => {
    const qs = [
      {
        header: 'h',
        question: '',
        options: [
          { label: 'a', description: 'b' },
          { label: 'c', description: 'd' },
        ],
      },
    ] as AskQuestionItem[];
    const r = await tool.execute({ questions: qs }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });

  it('rejects option missing description', async () => {
    const qs = [
      {
        header: 'h',
        question: 'q?',
        options: [
          { label: 'a', description: 'b' },
          { label: 'c' },
        ],
      },
    ] as unknown as AskQuestionItem[];
    const r = await tool.execute({ questions: qs }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_ARGS_INVALID);
  });
});

describe('AskUserQuestionTool execute', () => {
  it('happy path: bridge resolves → ok=true, content renders selected', async () => {
    let seenId: string | undefined;
    const tool = new AskUserQuestionTool({
      genRequestId: () => 'rid-1',
      bridge: async (id) => {
        seenId = id;
        const resp: AskUserQuestionResponse = {
          answers: [{ question: 'Which auth method?', selected: ['JWT'] }],
        };
        return resp;
      },
    });
    const r = await tool.execute({ questions: okQuestions() }, mkCtx());
    expect(r.ok).toBe(true);
    expect(seenId).toBe('rid-1');
    expect(r.content).toContain('Q1: Which auth method?');
    expect(r.content).toContain('Selected: "JWT"');
    expect(r.display).toMatchObject({
      answers: [{ question: 'Which auth method?', selected: ['JWT'] }],
    });
  });

  it('renders Other (custom) when answer has other field', async () => {
    const tool = new AskUserQuestionTool({
      bridge: async () => ({
        answers: [
          {
            question: 'Which auth method?',
            selected: [],
            other: 'OAuth2 via Auth0',
          },
        ],
      }),
    });
    const r = await tool.execute({ questions: okQuestions() }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Other (custom): OAuth2 via Auth0');
  });

  it('renders "(empty)" when no selected & no other', async () => {
    const tool = new AskUserQuestionTool({
      bridge: async () => ({
        answers: [{ question: 'Which auth method?', selected: [] }],
      }),
    });
    const r = await tool.execute({ questions: okQuestions() }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('(empty)');
  });

  it('bridge returns cancelled=true → ok=false, errorCode=TASK_LOOP_ABORTED', async () => {
    const tool = new AskUserQuestionTool({
      bridge: async () => ({ answers: [], cancelled: true }),
    });
    const r = await tool.execute({ questions: okQuestions() }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TASK_LOOP_ABORTED);
  });

  it('ctx.signal already aborted → immediate abort, bridge not called', async () => {
    const ac = new AbortController();
    ac.abort();
    let called = false;
    const tool = new AskUserQuestionTool({
      bridge: async () => {
        called = true;
        return { answers: [] };
      },
    });
    const r = await tool.execute({ questions: okQuestions() }, mkCtx(ac.signal));
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TASK_LOOP_ABORTED);
    expect(called).toBe(false);
  });

  it('bridge throws → ok=false, errorCode=TOOL_EXEC_FAILED', async () => {
    const tool = new AskUserQuestionTool({
      bridge: async () => {
        throw new Error('bridge boom');
      },
    });
    const r = await tool.execute({ questions: okQuestions() }, mkCtx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_FAILED);
    expect(r.content).toContain('bridge boom');
  });
});
