/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * tool-healing —— 工具侧自愈重试链（DESIGN §M10.6 工具侧）
 *
 * 职责：
 * - 当 LLM 产生的工具调用失败时，生成**结构化 healing hint** 注入回 tool result，
 *   让 LLM 在下一轮看清楚"错在哪、怎么改"，而不是拿到一段通用错误
 * - 通过 `HealingTracker` 计数 (toolName, errorCode) 维度的 healing 次数，
 *   超过 `maxAttempts` 后停止注入 hint，避免死循环
 *
 * 覆盖 3 类场景（DESIGN §M10.6）：
 * 1. 工具参数 JSON 不合法（`TOOL_ARGS_INVALID_JSON`）
 *    → "你返回的工具调用 arguments 不是合法 JSON（SyntaxError: ...）。请重新生成严格 JSON，
 *       不要带注释、尾随逗号或未转义的控制字符。"
 * 2. `search_replace` 多匹配（`TOOL_PATCH_UNIQUE_FAIL`）
 *    → "old_string 在文件中出现多次。请在 old_string 前后增加更多上下文使其唯一，
 *       或设置 replace_all=true 执行全局替换。"
 * 3. `search_replace` 无匹配（`TOOL_PATCH_NO_MATCH`）
 *    → "old_string 在文件中未找到，请先 read_file 校对实际内容（注意空白符/CRLF），
 *       再重新生成完全匹配的 old_string。"
 * 4. 通用参数校验失败（`TOOL_ARGS_INVALID` / `TOOL_ARGS_MISSING_REQUIRED`）
 *    → 透传原始错误 + 提示参考 tool schema 必填字段
 *
 * 设计要点：
 * - 纯函数 + 轻量计数器，不依赖 Provider / LLM 框架
 * - 与 W7b5b backoff 模块同层：backoff 管 Provider 层重试延迟，healing 管工具层错误回喂
 * - 默认每错误码 `maxAttempts=2`，确保最多 3 次调用（原始 + 2 次 healing 重试）后停止
 */

import { ErrorCodes, type ErrorCode } from '../errors/index.js';

export interface HealingPolicy {
  /** 该错误码下同一工具最多 healing 次数（超过不再注入 hint） */
  maxAttempts: number;
  /** 生成 hint 的函数；若返回 null/空串则视作不可 heal */
  buildHint: (ctx: HealingContext) => string;
}

export interface HealingContext {
  toolName: string;
  errorCode: ErrorCode | string;
  errorMessage: string;
  /** 本次 healing 已是第几次（1-based，首次 healing=1） */
  attempt: number;
}

/**
 * Healing 策略表：未列出的错误码默认不 heal（由原生错误消息喂给 LLM）。
 * 以稳健为优先：hint 用第二人称 + 明确动作指令。
 */
export const HEALING_TABLE: Partial<Record<ErrorCode, HealingPolicy>> = {
  [ErrorCodes.TOOL_ARGS_INVALID_JSON]: {
    maxAttempts: 2,
    buildHint: ({ errorMessage }) =>
      [
        `工具参数 JSON 解析失败：${sanitize(errorMessage)}`,
        '请重新生成**严格合法的 JSON**：',
        '- 不要使用注释、尾随逗号或单引号',
        '- 字符串中的换行、引号必须转义（\\n / \\"）',
        '- 对象/数组结构必须完整闭合',
        '然后再次调用工具。',
      ].join('\n'),
  },
  [ErrorCodes.TOOL_PATCH_UNIQUE_FAIL]: {
    maxAttempts: 2,
    buildHint: ({ errorMessage }) =>
      [
        `search_replace 失败（多处匹配）：${sanitize(errorMessage)}`,
        '请二选一修复：',
        '- 在 old_string 前/后增加更多上下文行使其**在文件中全局唯一**',
        '- 或设置 replace_all=true 执行**全局替换**',
      ].join('\n'),
  },
  [ErrorCodes.TOOL_PATCH_NO_MATCH]: {
    maxAttempts: 2,
    buildHint: ({ errorMessage }) =>
      [
        `search_replace 失败（未找到匹配）：${sanitize(errorMessage)}`,
        '常见原因：空白符差异（Tab vs 空格）/ 换行符差异（CRLF vs LF）/ 文件已被修改。',
        '建议先用 read_file 读取当前文件内容，再重新生成**完全匹配**的 old_string。',
      ].join('\n'),
  },
  [ErrorCodes.TOOL_ARGS_INVALID]: {
    maxAttempts: 1,
    buildHint: ({ errorMessage, toolName }) =>
      [
        `${toolName} 参数校验失败：${sanitize(errorMessage)}`,
        '请严格按照该工具的参数 schema 补全必填字段并重新调用。',
      ].join('\n'),
  },
  [ErrorCodes.TOOL_ARGS_MISSING_REQUIRED]: {
    maxAttempts: 1,
    buildHint: ({ errorMessage, toolName }) =>
      [
        `${toolName} 缺少必填参数：${sanitize(errorMessage)}`,
        '请补全必填字段后重新调用。',
      ].join('\n'),
  },
};

/** 查某错误码是否可 heal。 */
export function canHeal(code: ErrorCode | string): boolean {
  return HEALING_TABLE[code as ErrorCode] !== undefined;
}

/**
 * 追踪 `(toolName, errorCode)` 维度的 healing 次数。
 * 每个 TaskLoop 实例持有一个 tracker；task 结束即释放。
 */
export class HealingTracker {
  private counts = new Map<string, number>();

  /** 获取当前已 healing 次数（未命中返回 0）。 */
  get(toolName: string, code: ErrorCode | string): number {
    return this.counts.get(key(toolName, code)) ?? 0;
  }

  /** 计数 +1，返回 +1 后的次数。 */
  increment(toolName: string, code: ErrorCode | string): number {
    const k = key(toolName, code);
    const next = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, next);
    return next;
  }

  /** 重置某个 (toolName, code) —— 成功执行后可调用以清零。 */
  reset(toolName: string, code: ErrorCode | string): void {
    this.counts.delete(key(toolName, code));
  }

  /** 清空所有计数（任务结束后调用）。 */
  clear(): void {
    this.counts.clear();
  }
}

/**
 * 若错误码可 heal 且未超预算，返回包装后的 tool result content（原内容 + hint）；
 * 否则返回 null，上层继续使用原生错误消息。
 *
 * @param tracker HealingTracker 实例（调用方负责持有，通常在 TaskLoop 生命周期内复用）
 * @param ctx     - toolName / errorCode / errorMessage
 * @param origContent 原始工具返回的错误文本（将被前置到 hint 前，保证 LLM 看到原错）
 */
export function tryHeal(
  tracker: HealingTracker,
  ctx: Omit<HealingContext, 'attempt'>,
  origContent: string,
): string | null {
  const policy = HEALING_TABLE[ctx.errorCode as ErrorCode];
  if (!policy) return null;

  const current = tracker.get(ctx.toolName, ctx.errorCode);
  if (current >= policy.maxAttempts) return null; // 预算已耗尽

  const attempt = tracker.increment(ctx.toolName, ctx.errorCode);
  const hint = policy.buildHint({ ...ctx, attempt });
  if (!hint || !hint.trim()) return null;

  return `${origContent.trimEnd()}\n\n[Healing Hint ${attempt}/${policy.maxAttempts}]\n${hint}`;
}

// ─────────── 私有辅助 ───────────

function key(toolName: string, code: ErrorCode | string): string {
  return `${toolName}\u0000${code}`;
}

/** 防止错误消息过长把 hint 撑爆；裁剪到 400 字符并去掉换行噪音。 */
function sanitize(msg: string): string {
  if (!msg) return '';
  const one = msg.replace(/\s+/g, ' ').trim();
  if (one.length <= 400) return one;
  return one.slice(0, 400) + '…';
}
