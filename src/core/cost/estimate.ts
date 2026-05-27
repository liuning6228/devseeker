/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W10.6 · 调用前 token 估算（DESIGN §M16.5）
 *
 * MVP：不引入 tiktoken 依赖，使用以下启发式：
 *   - ASCII/英文近似：chars / 4
 *   - 中日韩统一汉字：1 字符 ≈ 1.5 tokens（cl100k_base 对中文通常拆出多 byte）
 *   - 其他 UTF-8 多字节区间：1 字符 ≈ 1 token
 *   - 每条消息额外 +4 token（role/结构开销，参考 OpenAI 经验值）
 *
 * 误差：±15%（设计目标 <5%，留待 W12 接真 tokenizer 后替换）。
 * 接口：`estimateTokens(text)` / `estimateMessagesTokens(messages)` /
 *       `estimatePromptCost(messages, pricing, avgCompletion?)`
 */

import type { Message, Pricing } from '../../providers/types.js';

const PER_MESSAGE_OVERHEAD = 4;
/** 默认 completion 估算长度（未提供时） */
const DEFAULT_AVG_COMPLETION_TOKENS = 300;

/**
 * 估算一段文本的 token 数。启发式：
 * - 扫描每个字符判区间
 * - 纯空白合并（两个连续空白按 1 字符计）
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let asciiChars = 0;
  let cjkChars = 0;
  let otherChars = 0;
  let lastSpace = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      if (lastSpace) continue;
      lastSpace = true;
      asciiChars++;
      continue;
    }
    lastSpace = false;
    if (code < 128) {
      asciiChars++;
    } else if (
      // CJK Unified + ext-A + hiragana/katakana + hangul syllables
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjkChars++;
    } else {
      otherChars++;
    }
  }
  const asciiTokens = Math.ceil(asciiChars / 4);
  const cjkTokens = Math.ceil(cjkChars * 1.5);
  const otherTokens = Math.ceil(otherChars * 1.2);
  return asciiTokens + cjkTokens + otherTokens;
}

/**
 * 估算一组 messages 的 prompt token 数（包含 role 开销）。
 * - content 是字符串：直接计
 * - content 是 parts 数组：只算 text 片段
 */
export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    total += PER_MESSAGE_OVERHEAD;
    const text = extractMessageText(m);
    total += estimateTokens(text);
  }
  return total;
}

/**
 * 根据 prompt 估算值 + 平均 completion 长度 + Pricing，计算调用前成本。
 * 返回：{ promptTokens, completionTokens, cost, currency }
 */
export function estimatePromptCost(
  messages: Message[],
  pricing: Pricing,
  avgCompletionTokens: number = DEFAULT_AVG_COMPLETION_TOKENS,
): {
  promptTokens: number;
  completionTokens: number;
  cost: number;
  currency: 'CNY' | 'USD';
} {
  const promptTokens = estimateMessagesTokens(messages);
  const completionTokens = Math.max(0, Math.floor(avgCompletionTokens));
  const cost =
    (promptTokens * pricing.inputPerMillion) / 1_000_000 +
    (completionTokens * pricing.outputPerMillion) / 1_000_000;
  return {
    promptTokens,
    completionTokens,
    cost: round6(cost),
    currency: pricing.currency,
  };
}

function extractMessageText(m: Message): string {
  const anyMsg = m as unknown as {
    content?: unknown;
    parts?: unknown;
  };
  const content = anyMsg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : extractPartText(p)))
      .join(' ');
  }
  if (Array.isArray(anyMsg.parts)) {
    return anyMsg.parts.map(extractPartText).join(' ');
  }
  return '';
}

function extractPartText(p: unknown): string {
  if (!p || typeof p !== 'object') return '';
  const obj = p as { type?: string; text?: string; content?: string };
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.content === 'string') return obj.content;
  return '';
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
