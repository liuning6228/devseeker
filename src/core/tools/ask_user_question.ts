/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * ask_user_question 工具（DESIGN §M11.5）
 *
 * 用途：模型在执行过程中遇到需要用户决策的岔路口时，弹出 1-4 个 Question 卡片收集答案。
 *
 * 契约：
 * - 参数 `questions` 数组长度 1-4；每题 options 数量 2-4
 * - 工具 await panel 回调，panel 通过 ask_question_response 回填
 * - 工具把回复的结构化 JSON 作为 content 返回给 LLM（tool role message）
 *
 * 取消行为：
 * - ctx.signal abort → 立即 resolve cancelled=true
 * - panel.dispose / new_session → pending ask 全部 cancelled
 *
 * 设计权衡：
 * - UI 总是自动追加 "Other" 选项（webview 层处理），工具层只关心结构化答案
 * - `selected` 数组即使单选也用数组，保持协议一致
 */

import type { ITool, ToolContext, ToolResult } from './types.js';
import type { AskQuestionItem } from '../../shared/protocol.js';
import { ErrorCodes } from '../errors/index.js';
import { getLogger } from '../../infra/logger.js';

const log = getLogger('tool.ask_user_question');

export interface AskUserQuestionAnswer {
  question: string;
  selected: string[];
  other?: string;
}

export interface AskUserQuestionResponse {
  answers: AskUserQuestionAnswer[];
  cancelled?: boolean;
}

/**
 * 外部回调：发起询问并等待用户响应。
 * panel.ts 实现：把 payload 推到 webview、登记 pending、response 到达时 resolve。
 */
export type AskUserQuestionBridge = (
  requestId: string,
  questions: AskQuestionItem[],
  signal: AbortSignal,
) => Promise<AskUserQuestionResponse>;

export interface AskUserQuestionArgs {
  questions: AskQuestionItem[];
}

export interface AskUserQuestionToolInit {
  bridge: AskUserQuestionBridge;
  /** 可选：id 生成器（测试注入） */
  genRequestId?: () => string;
}

const PARAMS_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      description: '1-4 个问题卡片；每个卡片 2-4 个选项。',
      items: {
        type: 'object',
        required: ['header', 'question', 'options'],
        properties: {
          header: { type: 'string', description: '短标签（≤12 字符），UI 以 chip 展示' },
          question: { type: 'string', description: '完整问题文本（以问号结尾）' },
          multiSelect: { type: 'boolean', description: '是否多选；缺省单选' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              required: ['label', 'description'],
              properties: {
                label: { type: 'string', description: '简短选项文案（1-5 词）' },
                description: { type: 'string', description: '说明该选项含义或后果' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const;

export class AskUserQuestionTool implements ITool<AskUserQuestionArgs, ToolResult> {
  readonly name = 'ask_user_question';
  readonly description =
    '当需要用户在多个方案间决策、或澄清模糊需求时弹出 1-4 个 Question 卡片收集结构化答案。' +
    '只用于对话确实需要用户输入的岔路，不要用于可以自行推断的场景。';
  readonly parameters = PARAMS_SCHEMA;
  readonly safetyLevel = 'external' as const;

  private readonly bridge: AskUserQuestionBridge;
  private readonly genRequestId: () => string;

  constructor(init: AskUserQuestionToolInit) {
    this.bridge = init.bridge;
    this.genRequestId = init.genRequestId ?? defaultGenRequestId;
  }

  async execute(args: AskUserQuestionArgs, ctx: ToolContext): Promise<ToolResult> {
    const parsed = validate(args);
    if (!parsed.ok) {
      return {
        ok: false,
        content: `Error: ${parsed.msg}`,
        errorCode: ErrorCodes.TOOL_ARGS_INVALID,
      };
    }
    if (ctx.signal.aborted) {
      return {
        ok: false,
        content: 'Error: ask_user_question 已取消',
        errorCode: ErrorCodes.TASK_LOOP_ABORTED,
      };
    }

    const requestId = this.genRequestId();
    log.info({ requestId, count: parsed.value.length }, 'ask_user_question begin');

    let response: AskUserQuestionResponse;
    try {
      response = await this.bridge(requestId, parsed.value, ctx.signal);
    } catch (e) {
      return {
        ok: false,
        content: `Error: ask_user_question bridge 异常 - ${String(e)}`,
        errorCode: ErrorCodes.TOOL_EXEC_FAILED,
      };
    }

    if (response.cancelled) {
      return {
        ok: false,
        content: 'Error: 用户取消了 ask_user_question',
        errorCode: ErrorCodes.TASK_LOOP_ABORTED,
      };
    }

    const summary = renderAnswersForLLM(parsed.value, response.answers);
    return {
      ok: true,
      content: summary,
      display: { answers: response.answers },
    };
  }
}

// ─────────── helpers ───────────

function validate(
  args: AskUserQuestionArgs,
): { ok: true; value: AskQuestionItem[] } | { ok: false; msg: string } {
  if (!args || typeof args !== 'object') {
    return { ok: false, msg: '参数必须是对象' };
  }
  const qs = args.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) {
    return { ok: false, msg: 'questions 必须是长度 1-4 的数组' };
  }
  for (let i = 0; i < qs.length; i += 1) {
    const q = qs[i] as AskQuestionItem | undefined;
    if (!q || typeof q.header !== 'string' || q.header.length === 0) {
      return { ok: false, msg: `questions[${i}].header 必填` };
    }
    if (typeof q.question !== 'string' || q.question.length === 0) {
      return { ok: false, msg: `questions[${i}].question 必填` };
    }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      return { ok: false, msg: `questions[${i}].options 必须为长度 2-4 的数组` };
    }
    for (let j = 0; j < q.options.length; j += 1) {
      const opt = q.options[j];
      if (!opt || typeof opt.label !== 'string' || typeof opt.description !== 'string') {
        return { ok: false, msg: `questions[${i}].options[${j}] 必须含 label+description` };
      }
    }
  }
  return { ok: true, value: qs };
}

function renderAnswersForLLM(
  questions: AskQuestionItem[],
  answers: AskUserQuestionAnswer[],
): string {
  const lines: string[] = ['User responses:'];
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i]!;
    const a = answers[i];
    lines.push(`Q${i + 1}: ${q.question}`);
    if (!a) {
      lines.push('  (no response)');
      continue;
    }
    if (a.selected.length > 0) {
      lines.push(`  Selected: ${a.selected.map((s) => `"${s}"`).join(', ')}`);
    }
    if (a.other) {
      lines.push(`  Other (custom): ${a.other}`);
    }
    if (a.selected.length === 0 && !a.other) {
      lines.push('  (empty)');
    }
  }
  return lines.join('\n');
}

function defaultGenRequestId(): string {
  return `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
