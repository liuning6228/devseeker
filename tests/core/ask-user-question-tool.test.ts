/**
 * Copyright (c) 2026 DevSeeker Contributors
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
 * - bridge cancelled=true 且 signal 未 abort（用户关弹窗）→ ok=true + 引导 LLM 继续
 * - bridge cancelled=true 且 signal 已 abort（任务中止）→ ok=false errorCode=TASK_LOOP_ABORTED
 * - ctx.signal 预先 aborted → 立即 TASK_LOOP_ABORTED，不调用 bridge
 * - bridge 抛异常 → TOOL_EXEC_FAILED
 * - genRequestId 注入被调用；safetyLevel=external
 * - ToolRunner 层：interactive 工具跳过审批门（且不削弱 deny / 其他 external 工具）
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AskUserQuestionTool,
  type AskUserQuestionResponse,
} from '../../src/core/tools/ask_user_question.js';
import type { ITool, ToolContext, ToolResult } from '../../src/core/tools/types.js';
import type { AskQuestionItem } from '../../src/shared/protocol.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import { ToolRegistry, ToolRunner } from '../../src/core/tools/registry.js';

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

  it('rejects options with length 1 (neither allowOther)', async () => {
    const qs: AskQuestionItem[] = [
      {
        header: 'h',
        question: 'q?',
        options: [{ label: 'only', description: 'x' }],
      },
    ];
    const r = await tool.execute({ questions: qs }, mkCtx());
    // 注: options.length >= 1 但 < 2 且 allowOther 未设置 → 仍为非法
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

  // 用户主动关掉弹窗 ≠ 中止任务：它只表示「不想从这些选项里选，你自己定」。
  // 必须 ok=true，否则 LLM 把它当成工具失败，典型反应是放弃整个任务或反复重试提问。
  it('user dismissed popup (signal not aborted) → ok=true with proceed instruction', async () => {
    const tool = new AskUserQuestionTool({
      bridge: async () => ({ answers: [], cancelled: true }),
    });
    const r = await tool.execute({ questions: okQuestions() }, mkCtx());
    expect(r.ok).toBe(true);
    expect(r.errorCode).toBeUndefined();
    expect(r.content).toContain('dismissed');
    expect(r.content).toContain('Do NOT ask the same question again');
  });

  // 任务真中止（用户点 Stop / 新会话 / dispose）→ 仍然是失败 + TASK_LOOP_ABORTED
  it('cancelled due to abort (signal aborted) → ok=false, errorCode=TASK_LOOP_ABORTED', async () => {
    const ac = new AbortController();
    const tool = new AskUserQuestionTool({
      bridge: async () => {
        // 模拟 bridge 挂起期间用户点了 Stop
        ac.abort();
        return { answers: [], cancelled: true };
      },
    });
    const r = await tool.execute({ questions: okQuestions() }, mkCtx(ac.signal));
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

/**
 * 回归：交互类工具不进审批门。
 *
 * ask_user_question 的 safetyLevel 是 external，而 DEFAULT_POLICY.external = 'confirm'，
 * 曾经导致它被拦在一个「工具名 + JSON 参数」的技术审批卡后面 —— 用户既看不到选项也
 * 看不到输入框，误点「拒绝」后真正的 QuestionCard 永远不会出现。修复方式是 ITool.interactive
 * 标记，而不是把 external 降级为 auto（那会让所有 MCP 工具集体绕过审批）。
 */
describe('interactive tools bypass the approval gate (ToolRunner)', () => {
  /** 与 ask_user_question 同为 external、但未标记 interactive 的对照工具（模拟 MCP 工具） */
  const externalTool: ITool = {
    name: 'mcpish.write_file',
    description: 'external but not interactive',
    parameters: { type: 'object', properties: {} },
    safetyLevel: 'external',
    execute: async (): Promise<ToolResult> => ({ ok: true, content: 'wrote' }),
  };

  function harness(opts: { approved: boolean; deny?: boolean }) {
    const calls: string[] = [];
    const registry = new ToolRegistry();
    registry.register(
      new AskUserQuestionTool({
        bridge: async () => ({
          answers: [{ question: 'Which auth method?', selected: ['JWT'] }],
        }),
      }) as unknown as ITool,
    );
    registry.register(externalTool);
    const runner = new ToolRunner(registry, {
      approvalGate: async (req) => {
        calls.push(req.tool.name);
        return { approved: opts.approved };
      },
      ...(opts.deny
        ? { approvalOverrides: [{ tool: 'ask_user_question', policy: 'deny' as const }] }
        : {}),
    });
    return { runner, calls };
  }

  const runOpts = (name: string, args: unknown) => ({
    toolCallId: 'tc-1',
    name,
    args: args as Record<string, unknown>,
    workspaceRoot: '/tmp',
    signal: new AbortController().signal,
    taskId: 't-1',
  });

  it('ask_user_question executes without invoking approvalGate', async () => {
    // approved=false：若它进了审批门就必然被拒，能明确区分「绕过」与「碰巧通过」
    const { runner, calls } = harness({ approved: false });
    const r = await runner.run(runOpts('ask_user_question', { questions: okQuestions() }));
    expect(calls).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.content).toContain('Selected: "JWT"');
  });

  it('non-interactive external tool still goes through approvalGate', async () => {
    const { runner, calls } = harness({ approved: false });
    const r = await runner.run(runOpts('mcpish.write_file', { path: 'a.txt' }));
    expect(calls).toEqual(['mcpish.write_file']);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_UNSAFE_BLOCKED);
  });

  // 只豁免 confirm，不豁免 deny —— 安全策略的硬拒绝对交互类工具依然生效
  it('deny policy still blocks an interactive tool', async () => {
    const { runner, calls } = harness({ approved: true, deny: true });
    const r = await runner.run(runOpts('ask_user_question', { questions: okQuestions() }));
    expect(calls).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_UNSAFE_BLOCKED);
  });
});

/**
 * 回归：交互类工具不设执行超时。
 *
 * 默认 DEFAULT_TOOL_TIMEOUT_MS = 30s，远不够用户读完 2-4 个问题再输入自定义方案。
 * 而 ToolRunner 的 withTimeout 只是 race：超时后弹窗仍在 UI 上，用户随后提交的答案
 * 会 resolve 一个已被丢弃的 Promise —— 答案静默丢失，而 LLM 已经带着「执行超时」
 * 往下走了。这比双重弹窗更隐蔽：用户明确回答了，AI 装作没听见。
 */
describe('interactive tools are exempt from the execution timeout (ToolRunner)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function runnerWithHangingTool(interactive: boolean) {
    let release!: (v: ToolResult) => void;
    const hanging = new Promise<ToolResult>((res) => {
      release = res;
    });
    const registry = new ToolRegistry();
    registry.register({
      name: 'hanging',
      description: 'hangs until released',
      parameters: { type: 'object', properties: {} },
      safetyLevel: 'read_only',
      ...(interactive ? { interactive: true } : {}),
      execute: () => hanging,
    } as ITool);
    const runner = new ToolRunner(registry);
    const promise = runner.run({
      toolCallId: 'tc-hang',
      name: 'hanging',
      args: {},
      workspaceRoot: '/tmp',
      signal: new AbortController().signal,
      taskId: 't-hang',
    });
    return { promise, release };
  }

  it('interactive tool survives well past the 30s default and still delivers the answer', async () => {
    vi.useFakeTimers();
    const { promise, release } = runnerWithHangingTool(true);

    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // 远超默认 30s：模拟用户慢慢读题 + 打字
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);

    // 用户终于提交 → 答案必须真的送到 LLM，而不是 resolve 一个已被丢弃的 Promise
    release({ ok: true, content: 'answered late' });
    const r = await promise;
    expect(r.ok).toBe(true);
    expect(r.content).toBe('answered late');
  });

  // 对照：普通工具的 30s 超时仍然生效（本改动未把超时守护全局关掉）
  it('non-interactive tool still times out at the 30s default', async () => {
    vi.useFakeTimers();
    const { promise } = runnerWithHangingTool(false);

    await vi.advanceTimersByTimeAsync(30_001);
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(ErrorCodes.TOOL_EXEC_TIMEOUT);
  });
});
