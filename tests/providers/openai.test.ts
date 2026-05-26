/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * OpenAIProvider 单测
 *
 * 继承自 OpenAICompatibleProvider，只补充 OpenAI 特定行为：
 * - id / pricing / defaults
 * - baseUrl/model 覆盖
 * - OpenAI 兼容模式下的错误归一化（复用基类）
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { OpenAIProvider } from '../../src/providers/openai.js';
import type { StreamEvent } from '../../src/providers/types.js';
import { AgentError, ErrorCodes } from '../../src/core/errors/index.js';
import { initLogger } from '../../src/infra/logger.js';
import * as os from 'node:os';
import * as path from 'node:path';

beforeEach(() => {
  initLogger({ logDir: path.join(os.tmpdir(), 'dualmind-test-logs'), level: 'error', dev: false });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function textResponse(status: number, text: string): Response {
  return new Response(text, { status });
}
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function sseStreamResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
async function drain(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('OpenAIProvider constructor', () => {
  it('throws on empty apiKey', () => {
    expect(() => new OpenAIProvider({ apiKey: '' })).toThrow(AgentError);
  });

  it('has correct id / capabilities / pricing', () => {
    const p = new OpenAIProvider({ apiKey: 'sk-test' });
    expect(p.id).toBe('openai-gpt');
    expect(p.capabilities).toContain('tool-use');
    expect(p.capabilities).toContain('vision');
    expect(p.pricing.currency).toBe('USD');
  });
});

describe('OpenAIProvider.probe', () => {
  it('hits /models endpoint with Bearer auth', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    const fetchMock = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init.headers as Record<string, string>).Authorization ?? '';
      return jsonResponse(200, { data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAIProvider({ apiKey: 'sk-oai' });
    const r = await p.probe();
    expect(r.ok).toBe(true);
    expect(capturedUrl).toBe('https://api.openai.com/v1/models');
    expect(capturedAuth).toBe('Bearer sk-oai');
  });

  it('respects custom baseUrl', async () => {
    let capturedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return jsonResponse(200, { data: [] });
      }),
    );
    const p = new OpenAIProvider({ apiKey: 'sk', baseUrl: 'https://proxy.example.com/v1/' });
    await p.probe();
    expect(capturedUrl).toBe('https://proxy.example.com/v1/models');
  });
});

describe('OpenAIProvider.createMessage', () => {
  it('streams text and uses gpt-4o-mini by default', async () => {
    let captured: any = null;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return sseStreamResponse([
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAIProvider({ apiKey: 'sk-test' });
    const events = await drain(p.createMessage({ messages: [{ role: 'user', content: 'q' }] }));

    expect(captured.model).toBe('gpt-4o-mini');
    expect(captured.stream).toBe(true);
    expect(events.find((e) => e.type === 'text_delta')).toEqual({ type: 'text_delta', text: 'hi' });
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'stop' });
  });

  it('401 maps to PROVIDER_AUTH_INVALID_API_KEY', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(401, 'bad key')));
    const p = new OpenAIProvider({ apiKey: 'sk-bad' });
    const events = await drain(p.createMessage({ messages: [{ role: 'user', content: 'x' }] }));
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      error: { code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY },
    });
  });
});
