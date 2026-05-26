/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W10.6 · estimateTokens fallback 单测
 *
 * 覆盖：
 * - empty/空字符串 → 0
 * - ASCII 文本 ≈ chars/4
 * - CJK 文本 ≈ chars*1.5
 * - 每消息固定 +4 开销
 * - estimatePromptCost 与 Pricing 线性耦合
 */

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateMessagesTokens,
  estimatePromptCost,
} from '../../src/core/cost/estimate.js';
import type { Message, Pricing } from '../../src/providers/types.js';

describe('estimateTokens', () => {
  it('returns 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });

  it('approximates ASCII as chars/4', () => {
    // 16 chars → 4 tokens
    expect(estimateTokens('abcdefghijklmnop')).toBe(4);
    // "hello world" 11 chars → 3 tokens
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('CJK counts ~1.5 tokens per char', () => {
    // 4 汉字 → ceil(4 * 1.5) = 6 tokens
    expect(estimateTokens('你好世界')).toBe(6);
    // 10 汉字 → ceil(10 * 1.5) = 15 tokens
    expect(estimateTokens('中文测试用例文本一二三')).toBe(17); // 11 汉字 → ceil(11*1.5)=17
  });

  it('mixed text sums segments', () => {
    const t = 'hi 你好'; // 'hi ' 3 ascii → ceil(3/4)=1 + 2 汉字 → ceil(3)=3 → 总 4
    expect(estimateTokens(t)).toBe(4);
  });
});

describe('estimateMessagesTokens', () => {
  it('adds per-message overhead', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    // user: 4 + ceil(5/4)=2 = 6
    // assistant: 4 + ceil(2/4)=1 = 5
    expect(estimateMessagesTokens(msgs)).toBe(11);
  });

  it('handles array-of-parts content', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'abcdefghij' }, // 10 ascii → ceil(10/4)=3
          { type: 'image_url', content: 'ignored' }, // treated as string 'ignored' 7 chars → ceil(7/4)=2
        ],
      },
    ] as unknown as Message[];
    // 4 overhead + ceil((10+1+7)/4) approx, but we join with space so
    // "abcdefghij ignored" = 18 chars → ceil(18/4)=5
    expect(estimateMessagesTokens(msgs)).toBe(4 + 5);
  });

  it('empty messages array → 0', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});

describe('estimatePromptCost', () => {
  const pricing: Pricing = {
    inputPerMillion: 1_000_000, // 1 元 / token
    outputPerMillion: 2_000_000, // 2 元 / token
    currency: 'CNY',
  };

  it('computes cost from pricing linearly', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hello' }];
    // prompt: 4+2 = 6 tokens
    // completion (default 300): 300 tokens
    const out = estimatePromptCost(msgs, pricing);
    expect(out.promptTokens).toBe(6);
    expect(out.completionTokens).toBe(300);
    // cost = 6 * 1 + 300 * 2 = 606
    expect(out.cost).toBe(606);
    expect(out.currency).toBe('CNY');
  });

  it('accepts custom avgCompletion', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hi' }];
    // prompt: 4+1 = 5；avgCompletion 100
    const out = estimatePromptCost(msgs, pricing, 100);
    expect(out.promptTokens).toBe(5);
    expect(out.completionTokens).toBe(100);
    // cost = 5 * 1 + 100 * 2 = 205
    expect(out.cost).toBe(205);
  });
});
