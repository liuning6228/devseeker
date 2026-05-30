/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * B-P2-8 · Token 预算裁剪单测
 * B-P3-8 · 真 tokenizer (js-tiktoken) + 启发式 fallback
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  estimateTokens,
  estimateContextTokens,
  applyTokenBudget,
  __setTokenizerForTests,
  resetTokenizerCache,
} from '../../src/core/prompts/token-budget.js';
import { PromptBuilder } from '../../src/core/prompts/builder.js';
import { DEFAULT_MODE } from '../../src/core/modes/index.js';
import type { PromptBuildContext } from '../../src/core/prompts/builder.js';
import type { MemoryRecord } from '../../src/core/memory/types.js';
import type { Rule } from '../../src/core/rules/types.js';

function mem(i: number, content = 'x'.repeat(200)): MemoryRecord {
  return {
    id: `m${i}`,
    title: `mem-${i}`,
    content,
    category: 'user_communication',
    keywords: ['a'],
    scope: 'workspace',
    createdAt: i,
    updatedAt: i,
  } as unknown as MemoryRecord;
}

function rule(i: number, priority = 10): Rule {
  return {
    name: `rule-${i}`,
    kind: 'always_on',
    description: `desc-${i}`,
    filePath: `/ws/. /rules/${i}.md`,
    content: 'y'.repeat(200),
    priority,
  } as unknown as Rule;
}

function makeCtx(overrides: Partial<PromptBuildContext> = {}): PromptBuildContext {
  return {
    mode: DEFAULT_MODE,
    skills: [],
    selectedRules: [],
    allRules: [],
    memories: [],
    ...overrides,
  };
}

describe('estimateTokens (启发式 fallback)', () => {
  afterEach(() => {
    resetTokenizerCache();
  });

  it('空字符串 → 0', () => {
    __setTokenizerForTests(null);
    expect(estimateTokens('')).toBe(0);
  });
  it('4 字符 → 1 token（启发式）', () => {
    __setTokenizerForTests(null);
    expect(estimateTokens('abcd')).toBe(1);
  });
  it('9 字符 → 3 tokens（启发式向上取整）', () => {
    __setTokenizerForTests(null);
    expect(estimateTokens('abcdefghi')).toBe(3);
  });
  it('伪 encoder 注入 → encode().length 优先', () => {
    __setTokenizerForTests({
      encode: (t: string) => Array.from({ length: Math.max(1, Math.floor(t.length / 2)) }, () => 0),
    });
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('abcdefgh')).toBe(4);
  });
  it('encoder.encode 抛异常 → fallback 启发式', () => {
    __setTokenizerForTests({
      encode: () => {
        throw new Error('broken');
      },
    });
    expect(estimateTokens('abcd')).toBe(1);
  });
});

describe('estimateTokens (js-tiktoken 真实 encoder)', () => {
  afterEach(() => {
    resetTokenizerCache();
  });

  it('真实 encoder 能加载并返回正整数', () => {
    resetTokenizerCache();
    const n = estimateTokens('Hello, world!');
    expect(typeof n).toBe('number');
    expect(n).toBeGreaterThan(0);
  });
});

describe('applyTokenBudget', () => {
  // 裁剪内部使用启发式，为保测试中的预算计算一致，处围强制启发式分支。
  beforeEach(() => {
    __setTokenizerForTests(null);
  });
  afterEach(() => {
    resetTokenizerCache();
  });

  it('budget 未设 → 原样返回，triggered=false', () => {
    const ctx = makeCtx({ memories: [mem(1), mem(2)] });
    const { ctx: out, report } = applyTokenBudget(ctx, undefined);
    expect(out).toBe(ctx);
    expect(report.triggered).toBe(false);
  });

  it('预算充足 → 不裁剪', () => {
    const ctx = makeCtx({ memories: [mem(1)] });
    const { ctx: out, report } = applyTokenBudget(ctx, { maxTokens: 100000, reserveForMessages: 0 });
    expect(out).toBe(ctx);
    expect(report.triggered).toBe(false);
  });

  it('预算过小 → 丢弃 memories 末尾', () => {
    const memories = [mem(1), mem(2), mem(3), mem(4), mem(5)];
    const ctx = makeCtx({ memories });
    const before = estimateContextTokens(ctx);
    const { ctx: out, report } = applyTokenBudget(ctx, {
      maxTokens: before - 100,
      reserveForMessages: 0,
    });
    expect(report.triggered).toBe(true);
    expect(report.droppedMemories).toBeGreaterThan(0);
    expect(out.memories.length).toBeLessThan(memories.length);
    // 头部保留
    expect(out.memories[0]?.id).toBe('m1');
  });

  it('selectedCodes 超长 → 截断到 selectedCodeMaxChars', () => {
    const longText = 'a'.repeat(5000);
    const ctx = makeCtx({
      attachments: {
        selectedCodes: [
          { filePath: 'a.ts', startLine: 1, endLine: 100, text: longText },
        ],
      },
    });
    const before = estimateContextTokens(ctx);
    const { ctx: out, report } = applyTokenBudget(ctx, {
      maxTokens: before - 500,
      reserveForMessages: 0,
      selectedCodeMaxChars: 500,
    });
    expect(report.triggered).toBe(true);
    expect(report.truncatedSelectedCodes).toBe(1);
    expect(out.attachments?.selectedCodes?.[0]?.text.length).toBeLessThan(longText.length);
    expect(out.attachments?.selectedCodes?.[0]?.text).toContain('(truncated for token budget)');
  });

  it('极小预算 → 丢弃几乎一切', () => {
    const ctx = makeCtx({
      memories: [mem(1), mem(2)],
      selectedRules: [rule(1), rule(2)],
      attachments: {
        gitContext: '<git_context>branch: main</git_context>',
        selectedCodes: [{ filePath: 'a.ts', startLine: 1, endLine: 2, text: 'x' }],
      },
    });
    const { ctx: out, report } = applyTokenBudget(ctx, {
      maxTokens: 100,
      reserveForMessages: 4096, // available = -3996 → 走 available<=0 分支
    });
    expect(report.triggered).toBe(true);
    expect(out.memories.length).toBe(0);
    expect(out.selectedRules.length).toBe(0);
    expect(out.attachments?.gitContext).toBeUndefined();
    expect(out.attachments?.selectedCodes?.length ?? 0).toBe(0);
  });

  it('gitContext 也超预算 → 被丢弃', () => {
    const ctx = makeCtx({
      attachments: {
        gitContext: 'z'.repeat(20000),
      },
    });
    const before = estimateContextTokens(ctx);
    const { ctx: out, report } = applyTokenBudget(ctx, {
      maxTokens: before - 3000,
      reserveForMessages: 0,
    });
    expect(report.triggered).toBe(true);
    expect(report.droppedGitContext).toBe(true);
    expect(out.attachments?.gitContext).toBeUndefined();
  });

  it('rules 按 priority 升序裁剪（优先丢低优先级）', () => {
    const r1 = rule(1, 1);
    const r2 = rule(2, 10);
    const r3 = rule(3, 100);
    const ctx = makeCtx({ selectedRules: [r1, r2, r3] });
    const before = estimateContextTokens(ctx);
    const { ctx: out, report } = applyTokenBudget(ctx, {
      maxTokens: before - 100,
      reserveForMessages: 0,
    });
    expect(report.triggered).toBe(true);
    expect(report.droppedRules).toBeGreaterThan(0);
    // 最后一条（pri=100）应该还在
    const names = out.selectedRules.map((r) => r.name);
    expect(names).toContain('rule-3');
  });
});

describe('PromptBuilder.build + budget 联合', () => {
  beforeEach(() => {
    __setTokenizerForTests(null);
  });
  afterEach(() => {
    resetTokenizerCache();
  });

  it('无 budget → 不返回 truncation', () => {
    const { truncation } = PromptBuilder.build(makeCtx());
    expect(truncation).toBeUndefined();
  });

  it('预算触发 → 返回 truncation 报告', () => {
    // 20 条 memory 约消耗 ~1100 tokens + 静态 1200 = 2300 → 超过 1500 预算
    const memories = Array.from({ length: 20 }, (_, i) => mem(i + 1));
    const ctx = makeCtx({
      memories,
      budget: { maxTokens: 1500, reserveForMessages: 0 },
    });
    const { truncation } = PromptBuilder.build(ctx);
    expect(truncation).toBeDefined();
    expect(truncation?.triggered).toBe(true);
    expect(truncation?.droppedMemories).toBeGreaterThan(0);
  });
});
