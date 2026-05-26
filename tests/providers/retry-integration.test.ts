/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * tests/providers/retry-integration.test.ts
 *
 * 覆盖 W7b5b Provider 侧自愈重试链的集成行为（Provider ↔ backoff 模块）：
 * - 5xx 自动重试直到成功
 * - 429 Retry-After 正确写入 AgentError.context.retryAfterMs 并传入 computeBackoff
 * - 401 / 400 不可重试错误码直通 error + done
 * - 用尽重试预算（shouldRetry=false）后最终 error
 * - 退避期间 abort 立即跳出（通过 sleepWithAbort 真实实现）
 *
 * 做法：用 vi.mock 把 computeBackoff 拦截为固定 1ms，避免真实等待；
 *       其他 export（shouldRetry / sleepWithAbort / parseRetryAfter）保留真实实现。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────── mock 必须在 import Provider 之前生效 ───────────
vi.mock('../../src/core/retry/backoff.js', async (orig) => {
  const real = await orig<typeof import('../../src/core/retry/backoff.js')>();
  // shouldRetry: attempt=0/1/2 → true, attempt>=3 → false
  const mockShouldRetry = vi.fn((code: string, attempt: number) => attempt < 3);
  return {
    ...real,
    computeBackoff: vi.fn(() => 1),
    shouldRetry: mockShouldRetry,
  };
});

import { OpenAIProvider } from '../../src/providers/openai.js';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { ErrorCodes } from '../../src/core/errors/index.js';
import type { StreamEvent } from '../../src/providers/types.js';
import { computeBackoff } from '../../src/core/retry/backoff.js';
import { initLogger } from '../../src/infra/logger.js';
import * as os from 'node:os';
import * as path from 'node:path';

const computeBackoffMock = computeBackoff as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  initLogger({
    logDir: path.join(os.tmpdir(), 'dualmind-test-logs'),
    level: 'error',
    dev: false,
  });
  computeBackoffMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────── 辅助 ───────────

function textResponse(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}

function sseOk(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const OK_SSE_FRAMES = [
  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
];

async function drain(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

// ─────────── OpenAI-compatible retry ───────────

describe('OpenAICompatibleProvider 自愈重试集成', () => {
  it('500 后成功：fetch 调用 2 次，最后 done reason=stop', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse(500, 'boom'))
      .mockResolvedValueOnce(sseOk(OK_SSE_FRAMES));
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAIProvider({ apiKey: 'sk-x' });
    const events = await drain(p.createMessage({ messages: [{ role: 'user', content: 'q' }] }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'ok' },
    ]);
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'stop' });

    // computeBackoff 被调用一次，错误码为 PROVIDER_SERVER_5XX，attempt=0
    expect(computeBackoffMock).toHaveBeenCalledTimes(1);
    const [code, attempt] = computeBackoffMock.mock.calls[0];
    expect(code).toBe(ErrorCodes.PROVIDER_SERVER_5XX);
    expect(attempt).toBe(0);
  });

  it('429 Retry-After 被解析成 retryAfterMs 并传给 computeBackoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse(429, 'rate', { 'retry-after': '3' }))
      .mockResolvedValueOnce(sseOk(OK_SSE_FRAMES));
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAIProvider({ apiKey: 'sk-x' });
    await drain(p.createMessage({ messages: [{ role: 'user', content: 'q' }] }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(computeBackoffMock).toHaveBeenCalledTimes(1);
    const [code, attempt, retryAfterMs] = computeBackoffMock.mock.calls[0];
    expect(code).toBe(ErrorCodes.PROVIDER_RATE_LIMITED);
    expect(attempt).toBe(0);
    expect(retryAfterMs).toBe(3000); // "3" 秒 → 3000ms
  });

  it('401 不可重试 → 一次 fetch 后直通 error + done', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(401, 'bad key'));
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAIProvider({ apiKey: 'sk-bad' });
    const events = await drain(p.createMessage({ messages: [{ role: 'user', content: 'q' }] }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(computeBackoffMock).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      error: { code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY },
    });
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'error' });
  });

  it('PROVIDER_STREAM_BROKEN 用尽重试后自动降级非流式', async () => {
    // 418 触发 responseToAgentError → PROVIDER_STREAM_BROKEN fallback
    // 重试配置：attempts=3，exp backoff（computeBackoff mock 返回 1ms）
    // 3 次流式重试全部 418 → 触发非流式降级 → 第 4 次 fetch（stream:false）也 418 → 最终 error
    const fetchMock = vi.fn().mockResolvedValue(textResponse(418, 'teapot'));
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAIProvider({ apiKey: 'sk-x' });
    const events = await drain(p.createMessage({ messages: [{ role: 'user', content: 'q' }] }));

    // shouldRetry mock: attempt<3 → true; attempt>=3 → false
    // 循环逻辑会在 attempt=3 时先 fetch 再 break，所以实际 4 次流式
    // → 4 次流式 fetch + 1 次非流式降级 = 共 5 次
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(computeBackoffMock).toHaveBeenCalledTimes(3);
    // 非流式降级也 418 → 最终 error
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      error: { code: ErrorCodes.PROVIDER_STREAM_BROKEN },
    });
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'error' });
  });

  it('退避期间 abort → 立即 emit TASK_LOOP_ABORTED + done aborted', async () => {
    // 让 computeBackoff 返回较大值，这样 abort 才有机会生效
    computeBackoffMock.mockReturnValueOnce(5_000);

    const fetchMock = vi.fn().mockResolvedValue(textResponse(500, 'boom'));
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAIProvider({ apiKey: 'sk-x' });
    const controller = new AbortController();
    const iter = p.createMessage({
      messages: [{ role: 'user', content: 'q' }],
      signal: controller.signal,
    });
    const drainPromise = drain(iter);

    // 给首次 fetch 一点时间拿到 500，然后 abort 进入 backoff 的 sleepWithAbort
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    const events = await drainPromise;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      error: { code: ErrorCodes.TASK_LOOP_ABORTED },
    });
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'aborted' });
  });

  it('STREAM_BROKEN 流式全失败 → 非流式降级成功', async () => {
    // 前 3 次流式 fetch 返回 418，第 4 次非流式请求成功返回完整 JSON
    const nonStreamingResponse = new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: 'fallback ok', tool_calls: undefined },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount <= 4) return textResponse(418, 'teapot');  // 4 次流式
      return nonStreamingResponse;
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAIProvider({ apiKey: 'sk-x' });
    const events = await drain(p.createMessage({ messages: [{ role: 'user', content: 'q' }] }));

    // 4 次流式 + 1 次非流式 = 5 次
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // 非流式降级成功 → 收到 text_delta + usage + done
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'fallback ok' },
    ]);
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
    });
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'stop' });
  });
});

// ─────────── Anthropic retry ───────────

describe('AnthropicProvider 自愈重试集成', () => {
  it('500 后成功：fetch 调用 2 次', async () => {
    const frame =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse(500, 'srv-broken'))
      .mockResolvedValueOnce(sseOk([frame]));
    vi.stubGlobal('fetch', fetchMock);

    const p = new AnthropicProvider({ apiKey: 'sk-ant' });
    const events = await drain(p.createMessage({ messages: [{ role: 'user', content: 'q' }] }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'ok' },
    ]);
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'stop' });
    expect(computeBackoffMock).toHaveBeenCalledWith(
      ErrorCodes.PROVIDER_SERVER_5XX,
      0,
      undefined,
    );
  });

  it('429 Retry-After 被解析并传入 computeBackoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse(429, 'slow down', { 'retry-after': '2' }))
      .mockResolvedValueOnce(textResponse(401, 'bad key')); // 第二次 401 强制终止
    vi.stubGlobal('fetch', fetchMock);

    const p = new AnthropicProvider({ apiKey: 'sk-ant' });
    await drain(p.createMessage({ messages: [{ role: 'user', content: 'q' }] }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [code, attempt, retryAfterMs] = computeBackoffMock.mock.calls[0];
    expect(code).toBe(ErrorCodes.PROVIDER_RATE_LIMITED);
    expect(attempt).toBe(0);
    expect(retryAfterMs).toBe(2000);
  });

  it('401 不可重试 → 一次 fetch 后直通 error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(401, 'bad'));
    vi.stubGlobal('fetch', fetchMock);

    const p = new AnthropicProvider({ apiKey: 'sk-ant' });
    const events = await drain(p.createMessage({ messages: [{ role: 'user', content: 'q' }] }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(computeBackoffMock).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      error: { code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY },
    });
  });
});
