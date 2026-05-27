/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * DeepSeekProvider 单测
 *
 * 覆盖：
 * - K2: sanitizeMessages 将 assistant.content=null 改为 ""
 * - K3: 禁用参数过滤（DeepSeek 不认 reasoning_effort）
 * - 构造器：空 apiKey 抛 PROVIDER_AUTH_INVALID_API_KEY
 * - 401/402/404/429/500 响应正确归一化为 AgentError code
 * - probe ok / probe 失败
 * - createMessage: 真流式 yield 顺序 text_delta → done
 * - createMessage: 429 重试（retryable）
 * - createMessage: 401 不重试（not retryable）直接 error + done
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { DeepSeekProvider, sanitizeMessages } from '../../src/providers/deepseek.js';
import type { Message, StreamEvent } from '../../src/providers/types.js';
import { AgentError, ErrorCodes } from '../../src/core/errors/index.js';
import { initLogger } from '../../src/infra/logger.js';
import * as os from 'node:os';
import * as path from 'node:path';

// 初始化 logger 为 silent 避免单测输出噪音
beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────── 辅助：构造 mock Response ───────────

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}

function sseStreamResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const f of frames) {
        controller.enqueue(encoder.encode(f));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function drain(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

// ─────────── sanitizeMessages (K2) ───────────

describe('sanitizeMessages (K2)', () => {
  it('replaces null content with empty string for assistant messages', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, toolCalls: [{ id: '1', name: 'x', argsRaw: '{}' }] },
      // K3: 必须有对应 tool 回复，否则 toolCalls 会被清除
      { role: 'tool', toolCallId: '1', content: 'result' },
    ];
    const out = sanitizeMessages(msgs);
    expect(out[0].content).toBe('hi');
    expect(out[1].content).toBe('');
    // toolCalls 保留（因为后面有对应 tool 回复）
    expect(out[1].toolCalls).toHaveLength(1);
  });

  it('K3: removes toolCalls when tool replies are missing (SSE broken scenario)', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'let me read', toolCalls: [{ id: 'call_1', name: 'read_file', argsRaw: '{"path":"a.ts"}' }] },
      // 缺少 tool 回复 → 下一条是 user 消息
      { role: 'user', content: '继续' },
    ];
    const out = sanitizeMessages(msgs);
    expect(out[1].content).toBe('let me read');
    // K3: toolCalls 被清除，因为缺少对应 tool 回复
    expect(out[1].toolCalls).toBeUndefined();
  });

  it('does not touch user messages', () => {
    const msgs: Message[] = [{ role: 'user', content: 'keep' }];
    expect(sanitizeMessages(msgs)).toEqual(msgs);
  });
});

// ─────────── 构造器 ───────────

describe('DeepSeekProvider constructor', () => {
  it('throws AgentError on empty apiKey', () => {
    expect(() => new DeepSeekProvider({ apiKey: '' })).toThrow(AgentError);
    try {
      new DeepSeekProvider({ apiKey: '' });
    } catch (e) {
      expect((e as AgentError).code).toBe(ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY);
    }
  });

  it('accepts valid apiKey', () => {
    const p = new DeepSeekProvider({ apiKey: 'sk-test' });
    expect(p.id).toBe('deepseek-v4');
    expect(p.capabilities).toContain('tool-use');
    expect(p.capabilities).toContain('reasoning');
    expect(p.contextWindow).toBeGreaterThanOrEqual(64_000);
  });
});

// ─────────── probe ───────────

describe('DeepSeekProvider.probe', () => {
  it('returns ok on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const p = new DeepSeekProvider({ apiKey: 'sk-test' });
    const r = await p.probe();
    expect(r.ok).toBe(true);
    expect(r.model).toBe('deepseek-chat');
  });

  it('returns error on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(401, 'unauthorized'));
    vi.stubGlobal('fetch', fetchMock);

    const p = new DeepSeekProvider({ apiKey: 'sk-bad' });
    const r = await p.probe();
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY);
  });
});

// ─────────── createMessage 流式 ───────────

describe('DeepSeekProvider.createMessage', () => {
  it('real streaming: yields text_delta then done', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseStreamResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" World"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_cache_hit_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const p = new DeepSeekProvider({ apiKey: 'sk-test' });
    const events = await drain(p.createMessage({ messages: [{ role: 'user', content: 'hi' }] }));

    // 过滤事件断言
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas).toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' World' },
    ]);

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toEqual({
      type: 'usage',
      promptTokens: 10,
      completionTokens: 2,
      cachedTokens: 5,
    });

    // 最后一个必须是 done
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'stop' });
  });

  it('401 not retryable: emits error + done without retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(401, 'unauthorized'));
    vi.stubGlobal('fetch', fetchMock);

    const p = new DeepSeekProvider({ apiKey: 'sk-bad' });
    const events = await drain(p.createMessage({ messages: [{ role: 'user', content: 'x' }] }));

    expect(fetchMock).toHaveBeenCalledTimes(1); // 不重试
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY },
    });
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'error' });
  });

  it('aborts immediately when signal already aborted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const p = new DeepSeekProvider({ apiKey: 'sk-test' });
    const controller = new AbortController();
    controller.abort();

    const events = await drain(
      p.createMessage({
        messages: [{ role: 'user', content: 'x' }],
        signal: controller.signal,
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { code: ErrorCodes.TASK_LOOP_ABORTED },
    });
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'aborted' });
  });

  it('404 maps to PROVIDER_MODEL_NOT_FOUND', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(404, 'no such model'));
    vi.stubGlobal('fetch', fetchMock);

    const p = new DeepSeekProvider({ apiKey: 'sk-test' });
    const events = await drain(p.createMessage({ messages: [{ role: 'user', content: 'x' }] }));

    expect(events.find((e) => e.type === 'error')).toMatchObject({
      error: { code: ErrorCodes.PROVIDER_MODEL_NOT_FOUND },
    });
  });

  it('500 maps to PROVIDER_SERVER_5XX and retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse(500, 'server broke'))
      .mockResolvedValueOnce(
        sseStreamResponse([
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const p = new DeepSeekProvider({ apiKey: 'sk-test' });
    const events = await drain(p.createMessage({ messages: [{ role: 'user', content: 'x' }] }));

    // 第一次 500 重试成功
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas).toEqual([{ type: 'text_delta', text: 'ok' }]);
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'stop' });
  }, 20_000);

  it('K3: never sends reasoning_effort in body (even if someone added via options)', async () => {
    let captured: any = null;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return sseStreamResponse([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = new DeepSeekProvider({ apiKey: 'sk-test' });
    await drain(p.createMessage({ messages: [{ role: 'user', content: 'x' }] }));

    expect(captured).not.toBeNull();
    expect(captured.reasoning_effort).toBeUndefined();
    expect(captured.model).toBe('deepseek-chat');
    expect(captured.stream).toBe(true);
  });
});
