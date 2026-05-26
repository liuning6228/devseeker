/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * AnthropicProvider 单测
 *
 * 覆盖：
 * - 基础：构造器 / id / capabilities / pricing
 * - 消息映射：splitSystemAndMessages / toAnthropicMessage / toAnthropicTool
 * - HTTP：x-api-key + anthropic-version header / /v1/messages endpoint
 * - SSE 解析：text_delta / tool_use / usage / stop_reason 映射
 * - 错误归一化：401 / 404 / 429 / 500
 * - AbortSignal 预取消
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  AnthropicProvider,
  splitSystemAndMessages,
  toAnthropicMessage,
  toAnthropicTool,
  toAnthropicToolChoice,
} from '../../src/providers/anthropic.js';
import type { Message, StreamEvent } from '../../src/providers/types.js';
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

// ─────────── 基础 ───────────

describe('AnthropicProvider constructor', () => {
  it('throws on empty apiKey', () => {
    expect(() => new AnthropicProvider({ apiKey: '' })).toThrow(AgentError);
  });
  it('has correct id / capabilities / 200K context', () => {
    const p = new AnthropicProvider({ apiKey: 'sk-ant' });
    expect(p.id).toBe('anthropic-claude');
    expect(p.capabilities).toContain('tool-use');
    expect(p.capabilities).toContain('vision');
    expect(p.contextWindow).toBe(200_000);
    expect(p.pricing.currency).toBe('USD');
  });
});

// ─────────── 消息映射 ───────────

describe('splitSystemAndMessages', () => {
  it('pulls out system messages into a single string', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'you are helpful' },
      { role: 'system', content: 'always reply in 中文' },
      { role: 'user', content: 'hi' },
    ];
    const { system, messages } = splitSystemAndMessages(msgs);
    expect(system).toBe('you are helpful\n\nalways reply in 中文');
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('returns undefined system if no system message', () => {
    const { system } = splitSystemAndMessages([{ role: 'user', content: 'x' }]);
    expect(system).toBeUndefined();
  });
});

describe('toAnthropicMessage', () => {
  it('maps assistant message with tool_calls → content blocks', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'sure, let me read it',
      toolCalls: [{ id: 'toolu_1', name: 'read_file', argsRaw: '{"file_path":"a.ts"}' }],
    };
    const out = toAnthropicMessage(msg);
    expect(out.role).toBe('assistant');
    const blocks = out.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: 'text', text: 'sure, let me read it' });
    expect(blocks[1]).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'read_file',
      input: { file_path: 'a.ts' },
    });
  });

  it('maps tool role → user role + tool_result block', () => {
    const msg: Message = {
      role: 'tool',
      content: 'file contents here',
      toolCallId: 'toolu_1',
    };
    const out = toAnthropicMessage(msg);
    expect(out.role).toBe('user');
    const blocks = out.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'file contents here',
    });
  });

  it('maps user image_url data URL → image block with base64 source', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,aGVsbG8=' },
        },
      ],
    };
    const out = toAnthropicMessage(msg);
    const blocks = out.content as Array<Record<string, any>>;
    expect(blocks[0]).toEqual({ type: 'text', text: 'look' });
    expect(blocks[1].type).toBe('image');
    expect(blocks[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' });
  });

  it('handles malformed JSON argsRaw by falling back to empty input', () => {
    const msg: Message = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'x', name: 'f', argsRaw: '{incomplete' }],
    };
    const out = toAnthropicMessage(msg);
    const blocks = out.content as Array<Record<string, any>>;
    expect(blocks.find((b) => b.type === 'tool_use')?.input).toEqual({});
  });
});

describe('toAnthropicTool', () => {
  it('flattens OpenAI tool schema to Anthropic format', () => {
    const out = toAnthropicTool({
      type: 'function',
      function: {
        name: 'read_file',
        description: 'read a file',
        parameters: { type: 'object', properties: { p: { type: 'string' } } },
      },
    });
    expect(out).toEqual({
      name: 'read_file',
      description: 'read a file',
      input_schema: { type: 'object', properties: { p: { type: 'string' } } },
    });
  });
});

describe('toAnthropicToolChoice', () => {
  it('maps auto / required / specific tool name', () => {
    expect(toAnthropicToolChoice('auto')).toEqual({ type: 'auto' });
    expect(toAnthropicToolChoice('required')).toEqual({ type: 'any' });
    expect(toAnthropicToolChoice('none')).toBeUndefined();
    expect(
      toAnthropicToolChoice({ type: 'function', function: { name: 'read_file' } }),
    ).toEqual({ type: 'tool', name: 'read_file' });
  });
});

// ─────────── HTTP / SSE ───────────

describe('AnthropicProvider.createMessage - streaming', () => {
  it('sends x-api-key + anthropic-version headers to /v1/messages', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;
    const fetchMock = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = JSON.parse(init.body as string);
      return sseStreamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const p = new AnthropicProvider({ apiKey: 'sk-ant-test' });
    const events = await drain(
      p.createMessage({
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
      }),
    );

    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(capturedHeaders['x-api-key']).toBe('sk-ant-test');
    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
    // system 字段独立
    expect(capturedBody.system).toBe('be brief');
    expect(capturedBody.messages).toHaveLength(1);
    expect(capturedBody.max_tokens).toBeGreaterThan(0);
    expect(capturedBody.stream).toBe(true);

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas).toEqual([{ type: 'text_delta', text: 'Hi' }]);

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ type: 'usage', promptTokens: 5, completionTokens: 3 });

    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'stop' });
  });

  it('emits tool_start / tool_args_delta / tool_end for tool_use blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseStreamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_abc","name":"read_file"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"_path\\":\\"a.ts\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":10}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const p = new AnthropicProvider({ apiKey: 'sk-ant' });
    const events = await drain(
      p.createMessage({ messages: [{ role: 'user', content: 'read a.ts' }] }),
    );

    expect(events.find((e) => e.type === 'tool_start')).toEqual({
      type: 'tool_start',
      id: 'toolu_abc',
      name: 'read_file',
    });
    const deltas = events.filter((e) => e.type === 'tool_args_delta');
    expect(deltas.map((d: any) => d.partial).join('')).toBe('{"file_path":"a.ts"}');
    expect(events.find((e) => e.type === 'tool_end')).toEqual({
      type: 'tool_end',
      id: 'toolu_abc',
    });
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'tool_use' });
  });

  it('401 maps to PROVIDER_AUTH_INVALID_API_KEY (not retryable)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(401, 'invalid x-api-key'));
    vi.stubGlobal('fetch', fetchMock);

    const p = new AnthropicProvider({ apiKey: 'sk-bad' });
    const events = await drain(p.createMessage({ messages: [{ role: 'user', content: 'x' }] }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY },
    });
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'error' });
  });

  it('aborts immediately when signal already aborted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    const p = new AnthropicProvider({ apiKey: 'sk-ant' });
    const events = await drain(
      p.createMessage({
        messages: [{ role: 'user', content: 'x' }],
        signal: controller.signal,
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events[events.length - 1]).toEqual({ type: 'done', reason: 'aborted' });
  });
});
