/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * QwenVLProvider 单测
 * - DashScope compatible-mode baseUrl
 * - capability 包含 vision
 * - 多模态 image_url content 能透传（OpenAI 兼容 schema）
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { QwenVLProvider } from '../../src/providers/qwen-vl.js';
import type { StreamEvent } from '../../src/providers/types.js';
import { AgentError } from '../../src/core/errors/index.js';
import { initLogger } from '../../src/infra/logger.js';
import * as os from 'node:os';
import * as path from 'node:path';

beforeEach(() => {
  initLogger({ logDir: path.join(os.tmpdir(), 'dualmind-test-logs'), level: 'error', dev: false });
});
afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('QwenVLProvider basics', () => {
  it('has id qwen-vl-max and vision capability', () => {
    const p = new QwenVLProvider({ apiKey: 'sk-qwen' });
    expect(p.id).toBe('qwen-vl-max');
    expect(p.capabilities).toContain('vision');
    expect(p.pricing.currency).toBe('CNY');
  });

  it('throws on empty apiKey', () => {
    expect(() => new QwenVLProvider({ apiKey: '' })).toThrow(AgentError);
  });

  it('defaults to DashScope compatible-mode baseUrl', async () => {
    let capturedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return sseStreamResponse([
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }),
    );
    const p = new QwenVLProvider({ apiKey: 'sk' });
    await drain(p.createMessage({ messages: [{ role: 'user', content: 'x' }] }));
    expect(capturedUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
  });
});

describe('QwenVLProvider vision payload', () => {
  it('passes through image_url ContentPart to OpenAI-compatible chat/completions body', async () => {
    let captured: any = null;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return sseStreamResponse([
          'data: {"choices":[{"delta":{"content":"seen"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }),
    );
    const p = new QwenVLProvider({ apiKey: 'sk-qwen' });
    await drain(
      p.createMessage({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '描述这张图' },
              { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
            ],
          },
        ],
      }),
    );
    const firstMsg = captured.messages[0];
    expect(firstMsg.role).toBe('user');
    expect(Array.isArray(firstMsg.content)).toBe(true);
    expect(firstMsg.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/x.png' },
    });
    expect(captured.model).toBe('qwen-vl-max-latest');
  });
});
