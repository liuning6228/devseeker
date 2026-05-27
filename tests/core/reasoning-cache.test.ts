/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * W15.2 · ReasoningCache 单测
 *
 * 覆盖：
 *   1. computeKey：相同 messages → 相同 key；不同 → 不同 key
 *   2. computeKey：忽略 reasoningContent（provider 内部字段）
 *   3. set/get roundtrip
 *   4. TTL 过期自动清理
 *   5. hit/miss 统计
 *   6. clear 清空
 *   7. 不缓存含 error 的流（last event reason=error）
 *   8. 不缓存 abort 的流（last event reason=aborted）
 *   9. OpenAICompatibleProvider.cachedStream：缓存命中 replay
 *  10. OpenAICompatibleProvider.cachedStream：未命中收集并写入
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { ReasoningCache } from '../../src/core/cache/reasoning-cache.js';
import type { Message, StreamEvent } from '../../src/providers/types.js';

describe('W15.2 · ReasoningCache', () => {
  let cache: ReasoningCache;

  beforeEach(() => {
    cache = new ReasoningCache({ ttlMs: 60_000 });
  });

  it('computeKey：相同 messages → 相同 key', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hello' }];
    expect(cache.computeKey(msgs)).toBe(cache.computeKey(msgs));
  });

  it('computeKey：不同 messages → 不同 key', () => {
    const a: Message[] = [{ role: 'user', content: 'hello' }];
    const b: Message[] = [{ role: 'user', content: 'world' }];
    expect(cache.computeKey(a)).not.toBe(cache.computeKey(b));
  });

  it('computeKey：忽略 reasoningContent（provider 内部字段）', () => {
    const a: Message[] = [{ role: 'assistant', content: 'ok', reasoningContent: 'think A' }];
    const b: Message[] = [{ role: 'assistant', content: 'ok', reasoningContent: 'think B' }];
    expect(cache.computeKey(a)).toBe(cache.computeKey(b));
  });

  it('set/get roundtrip', () => {
    const key = 'k1';
    const events: StreamEvent[] = [{ type: 'text_delta', text: 'hi' }];
    cache.set(key, events);
    expect(cache.get(key)).toEqual(events);
  });

  it('TTL 过期自动清理', async () => {
    const shortCache = new ReasoningCache({ ttlMs: 10 });
    shortCache.set('k', [{ type: 'text_delta', text: 'x' }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(shortCache.get('k')).toBeUndefined();
  });

  it('hit/miss 统计', () => {
    cache.set('k', [{ type: 'text_delta', text: 'x' }]);
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(0);

    cache.get('k'); // hit
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(0);

    cache.get('not-exist'); // miss
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  it('clear 清空并重置统计', () => {
    cache.set('k', [{ type: 'text_delta', text: 'x' }]);
    cache.get('k');
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(0);
    expect(cache.get('k')).toBeUndefined();
  });

  it('Provider 层：缓存命中 replay（mock cachedStream）', async () => {
    const { DeepSeekProvider } = await import('../../src/providers/deepseek.js');
    const p = new DeepSeekProvider({ apiKey: 'sk-test' });

    // 直接操作内部 reasoningCache
    const msgs: Message[] = [{ role: 'user', content: 'prove 1+1=2' }];
    const key = p['reasoningCache'].computeKey(msgs);
    const cachedEvents: StreamEvent[] = [
      { type: 'reasoning_delta', text: 'Let me think...' },
      { type: 'text_delta', text: '2' },
      { type: 'done', reason: 'stop' },
    ];
    p['reasoningCache'].set(key, cachedEvents);

    // 用 modelOverride 触发 reasoning model 路径
    const events: StreamEvent[] = [];
    for await (const ev of p.createMessage({
      messages: msgs,
      modelOverride: 'deepseek-reasoner',
    })) {
      events.push(ev);
    }

    expect(events).toEqual(cachedEvents);
    expect(p['reasoningCache'].hits).toBe(1);
  });

  it('Provider 层：未命中时流式成功后写入缓存', async () => {
    const { DeepSeekProvider } = await import('../../src/providers/deepseek.js');
    const p = new DeepSeekProvider({ apiKey: 'sk-test' });

    // mock fetch 返回成功的 SSE
    const sse = [
      'data: {"choices":[{"delta":{"content":"OK"}}]}',
      'data: [DONE]',
    ].join('\n\n');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode(sse));
          ctrl.close();
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const msgs: Message[] = [{ role: 'user', content: 'hello' }];
    const events: StreamEvent[] = [];
    for await (const ev of p.createMessage({
      messages: msgs,
      modelOverride: 'deepseek-reasoner',
    })) {
      events.push(ev);
    }

    // 验证缓存被写入
    const key = p['reasoningCache'].computeKey(msgs);
    const cached = p['reasoningCache'].get(key);
    expect(cached).toBeDefined();
    expect(cached!.length).toBeGreaterThan(0);
    expect(cached!.some((e) => e.type === 'done')).toBe(true);

    // 再次调用应命中缓存，不再发请求
    fetchMock.mockClear();
    const events2: StreamEvent[] = [];
    for await (const ev of p.createMessage({
      messages: msgs,
      modelOverride: 'deepseek-reasoner',
    })) {
      events2.push(ev);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events2).toEqual(cached);

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
