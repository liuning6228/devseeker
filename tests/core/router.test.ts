/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

import { describe, it, expect } from 'vitest';
import {
  ModelRouter,
  hasVisionContent,
  shouldKeepVisionPolicy,
} from '../../src/core/router/router.js';
import type { IProvider } from '../../src/providers/base.js';
import type { Capability, Pricing, ProviderId } from '../../src/providers/types.js';

function fakeProvider(opts: {
  id: ProviderId;
  capabilities?: Capability[];
  contextWindow?: number;
  pricing?: Pricing;
}): IProvider {
  return {
    id: opts.id,
    capabilities: opts.capabilities ?? ['text', 'tool-use'],
    contextWindow: opts.contextWindow ?? 128_000,
    pricing:
      opts.pricing ?? {
        inputPerMillion: 2,
        outputPerMillion: 8,
        currency: 'CNY',
      },
    createMessage: () => ({
      [Symbol.asyncIterator]: async function* () {},
    }),
    probe: async () => ({ ok: true, latencyMs: 1 }),
    countTokens: async () => 0,
  } as unknown as IProvider;
}

const DS = fakeProvider({
  id: 'deepseek-v4',
  capabilities: ['text', 'tool-use', 'reasoning', 'prompt-cache'],
  pricing: { inputPerMillion: 2, outputPerMillion: 8, currency: 'CNY' },
});
const GPT = fakeProvider({
  id: 'openai-gpt',
  capabilities: ['text', 'tool-use', 'vision', 'prompt-cache'],
  pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6, currency: 'USD' },
});
const QVL = fakeProvider({
  id: 'qwen-vl-max',
  capabilities: ['text', 'tool-use', 'vision'],
  contextWindow: 32_000,
  pricing: { inputPerMillion: 20, outputPerMillion: 60, currency: 'CNY' },
});
const ANTH = fakeProvider({
  id: 'anthropic-claude',
  capabilities: ['text', 'tool-use', 'prompt-cache'],
  contextWindow: 200_000,
  pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
});

describe('hasVisionContent', () => {
  it('returns false for pure text messages', () => {
    expect(hasVisionContent([{ role: 'user', content: 'hello' }])).toBe(false);
  });
  it('returns true when any part has image_url', () => {
    expect(
      hasVisionContent([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          ],
        },
      ]),
    ).toBe(true);
  });
});

describe('ModelRouter.pick', () => {
  it('returns undefined when no providers', () => {
    const r = new ModelRouter({ providers: [] });
    expect(r.pick({ messages: [{ role: 'user', content: 'hi' }] })).toBeUndefined();
  });

  it('respects user-preferred provider when feasible', () => {
    const r = new ModelRouter({ providers: [DS, GPT], defaultProviderId: 'deepseek-v4' });
    const d = r.pick({
      messages: [{ role: 'user', content: 'hi' }],
      hint: { preferredProvider: 'openai-gpt' },
    });
    expect(d?.provider.id).toBe('openai-gpt');
    expect(d?.reason).toBe('user-preferred');
  });

  it('ignores preferred provider if it cannot satisfy vision', () => {
    const r = new ModelRouter({ providers: [DS, QVL] });
    const d = r.pick({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
          ],
        },
      ],
      hint: { preferredProvider: 'deepseek-v4' },
    });
    // DS 不支持 vision → 退到 QVL
    expect(d?.provider.id).toBe('qwen-vl-max');
  });

  it('returns undefined when nothing meets hard constraint', () => {
    // 只有 DS（无 vision），但需求 vision
    const r = new ModelRouter({ providers: [DS] });
    const d = r.pick({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
        },
      ],
    });
    expect(d).toBeUndefined();
  });

  it('honors defaultProvider when feasible', () => {
    const r = new ModelRouter({
      providers: [DS, GPT, ANTH],
      defaultProviderId: 'anthropic-claude',
    });
    const d = r.pick({ messages: [{ role: 'user', content: 'hi' }] });
    expect(d?.provider.id).toBe('anthropic-claude');
    expect(d?.reason).toBe('default');
  });

  it('picks cheapest when no default', () => {
    const r = new ModelRouter({ providers: [DS, QVL, ANTH] });
    // DS: 2+24=26 CNY; QVL: 20+180=200 CNY; ANTH: (3+45)*7=336 CNY
    const d = r.pick({ messages: [{ role: 'user', content: 'hi' }] });
    expect(d?.provider.id).toBe('deepseek-v4');
    expect(d?.reason).toContain('cheapest');
  });

  it('filters by needsReasoning', () => {
    const r = new ModelRouter({ providers: [GPT, DS] });
    const d = r.pick({
      messages: [{ role: 'user', content: 'hard' }],
      hint: { needsReasoning: true },
    });
    // GPT 无 reasoning → DS
    expect(d?.provider.id).toBe('deepseek-v4');
    expect(d?.reason).toContain('needs-reasoning');
  });

  it('filters by minContextWindow', () => {
    const r = new ModelRouter({ providers: [QVL, ANTH] });
    const d = r.pick({
      messages: [{ role: 'user', content: 'huge' }],
      hint: { minContextWindow: 100_000 },
    });
    expect(d?.provider.id).toBe('anthropic-claude');
  });

  it('deprioritizes providers with repeated failures', () => {
    // DS (CNY 26) vs QVL (CNY 200)：DS 原本最便宜；降权后选 QVL
    const r = new ModelRouter({ providers: [DS, QVL] });
    r.recordFailure('deepseek-v4');
    r.recordFailure('deepseek-v4');
    const d = r.pick({ messages: [{ role: 'user', content: 'hi' }] });
    expect(d?.provider.id).toBe('qwen-vl-max');
  });

  it('recordSuccess clears failure', () => {
    // QVL (CNY 200) vs DS (CNY 26)：DS 更便宜；降权 DS 后会选 QVL；recordSuccess 后再选 DS
    const r = new ModelRouter({ providers: [DS, QVL] });
    r.recordFailure('deepseek-v4');
    r.recordFailure('deepseek-v4');
    expect(r.pick({ messages: [{ role: 'user', content: 'hi' }] })?.provider.id).toBe(
      'qwen-vl-max',
    );
    r.recordSuccess('deepseek-v4');
    const d = r.pick({ messages: [{ role: 'user', content: 'hi' }] });
    expect(d?.provider.id).toBe('deepseek-v4'); // 恢复为最便宜
  });
});

describe('ModelRouter.pickFallback', () => {
  it('excludes failed provider', () => {
    const r = new ModelRouter({ providers: [DS, GPT] });
    const f = r.pickFallback({
      messages: [{ role: 'user', content: 'hi' }],
      failedId: 'deepseek-v4',
    });
    expect(f?.provider.id).toBe('openai-gpt');
    expect(f?.reason).toContain('fallback-of-deepseek-v4');
  });

  it('returns undefined when no alternatives', () => {
    const r = new ModelRouter({ providers: [DS] });
    const f = r.pickFallback({
      messages: [{ role: 'user', content: 'hi' }],
      failedId: 'deepseek-v4',
    });
    expect(f).toBeUndefined();
  });

  it('fallback path skips defaultProvider that already failed', () => {
    const r = new ModelRouter({
      providers: [DS, GPT, QVL],
      defaultProviderId: 'deepseek-v4',
    });
    const f = r.pickFallback({
      messages: [{ role: 'user', content: 'hi' }],
      failedId: 'deepseek-v4',
    });
    expect(f?.provider.id).not.toBe('deepseek-v4');
  });
});

describe('ModelRouter.update', () => {
  it('hot-swaps providers', () => {
    const r = new ModelRouter({ providers: [DS] });
    r.update({ providers: [GPT] });
    const d = r.pick({ messages: [{ role: 'user', content: 'hi' }] });
    expect(d?.provider.id).toBe('openai-gpt');
  });
});

// ─────────── W13.3-C · VLM 历史图持续注入 ───────────

describe('shouldKeepVisionPolicy · W13.3-C', () => {
  const IMG_DATA_URL = 'data:image/png;base64,AAAA';

  it('both empty → false', () => {
    expect(shouldKeepVisionPolicy(undefined, [])).toBe(false);
    expect(shouldKeepVisionPolicy([], [])).toBe(false);
  });

  it('this turn has images → true (even if history empty)', () => {
    expect(shouldKeepVisionPolicy([IMG_DATA_URL], [])).toBe(true);
  });

  it('history has image in user message → true (even if current turn text-only)', () => {
    const priorMessages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: '看这个报错' },
          { type: 'image_url' as const, image_url: { url: IMG_DATA_URL } },
        ],
      },
      { role: 'assistant' as const, content: 'ok' },
    ];
    expect(shouldKeepVisionPolicy(undefined, priorMessages)).toBe(true);
  });

  it('history has only text → false (零 token 成本，避免误注入)', () => {
    const priorMessages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: '你好' },
    ];
    expect(shouldKeepVisionPolicy(undefined, priorMessages)).toBe(false);
  });

  it('history has image in ANY turn → true (full-history scan)', () => {
    const priorMessages = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply' },
      { role: 'user' as const, content: 'second' },
      { role: 'assistant' as const, content: 'reply2' },
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: '第3轮才发图' },
          { type: 'image_url' as const, image_url: { url: IMG_DATA_URL } },
        ],
      },
      { role: 'assistant' as const, content: 'reply3' },
    ];
    expect(shouldKeepVisionPolicy(undefined, priorMessages)).toBe(true);
  });

  it('assistant content array with image_url also counts (edge case)', () => {
    // 理论上 assistant 一般不出图，但 hasVisionContent 纯按 content 结构扫描，
    // 保证逻辑一致性。
    const priorMessages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'ok' },
          { type: 'image_url' as const, image_url: { url: IMG_DATA_URL } },
        ],
      },
    ];
    expect(shouldKeepVisionPolicy(undefined, priorMessages)).toBe(true);
  });

  it('this turn image takes priority (history empty irrelevant)', () => {
    // 本 turn 有图 → 直接 true，不再扫描历史
    expect(shouldKeepVisionPolicy([IMG_DATA_URL, IMG_DATA_URL], [])).toBe(true);
  });
});
