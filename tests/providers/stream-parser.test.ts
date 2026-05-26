/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * StreamParser 单测
 *
 * 覆盖：
 * - K1: reasoning_content 双路径（delta 与 message 两处兜底）
 * - text_delta / reasoning_delta 增量
 * - tool_calls 累积 → tool_start / tool_args_delta / tool_end
 * - usage cachedTokens 上报（DeepSeek prompt_cache_hit_tokens）
 * - finish_reason 映射
 * - parseSSEStream 基本切分
 * - partialJsonParse 对不完整 JSON 容错
 */
import { describe, it, expect } from 'vitest';
import {
  StreamParser,
  parseSSEStream,
  partialJsonParse,
} from '../../src/providers/stream-parser.js';

function collect<T>(gen: Generator<T>): T[] {
  const arr: T[] = [];
  for (const v of gen) arr.push(v);
  return arr;
}

describe('StreamParser', () => {
  it('emits text_delta from delta.content', () => {
    const p = new StreamParser();
    const events = collect(
      p.consume({
        choices: [{ delta: { content: 'Hello' } }],
      }),
    );
    expect(events).toEqual([{ type: 'text_delta', text: 'Hello' }]);
  });

  it('K1: emits reasoning_delta from delta.reasoning_content', () => {
    const p = new StreamParser();
    const events = collect(
      p.consume({
        choices: [{ delta: { reasoning_content: 'thinking...' } }],
      }),
    );
    expect(events).toEqual([{ type: 'reasoning_delta', text: 'thinking...' }]);
  });

  it('K1: falls back to message.reasoning_content (non-stream shape)', () => {
    const p = new StreamParser();
    const events = collect(
      p.consume({
        choices: [{ message: { reasoning_content: 'from message', content: 'final answer' } }],
      }),
    );
    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'from message' },
      { type: 'text_delta', text: 'final answer' },
    ]);
  });

  it('accumulates tool_calls and emits tool_start once, then tool_args_delta', () => {
    const p = new StreamParser();
    // chunk 1: name + 部分 args
    const ev1 = collect(
      p.consume({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"pa' },
                },
              ],
            },
          },
        ],
      }),
    );
    expect(ev1).toEqual([
      { type: 'tool_start', id: 'call_abc', name: 'read_file' },
      { type: 'tool_args_delta', id: 'call_abc', partial: '{"pa' },
    ]);
    // chunk 2: 继续 args
    const ev2 = collect(
      p.consume({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }],
            },
          },
        ],
      }),
    );
    expect(ev2).toEqual([{ type: 'tool_args_delta', id: 'call_abc', partial: 'th":"a.ts"}' }]);
  });

  it('emits tool_end when finish_reason arrives', () => {
    const p = new StreamParser();
    collect(
      p.consume({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'x', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
    );
    const finish = collect(
      p.consume({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      }),
    );
    expect(finish).toEqual([{ type: 'tool_end', id: 'call_1' }]);
    expect(p.getDoneReason()).toBe('tool_use');
  });

  it('emits usage with cachedTokens from DeepSeek prompt_cache_hit_tokens', () => {
    const p = new StreamParser();
    const events = collect(
      p.consume({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 20,
        },
      }),
    );
    expect(events).toEqual([
      { type: 'usage', promptTokens: 100, completionTokens: 50, cachedTokens: 80 },
    ]);
  });

  it('omits cachedTokens when not present', () => {
    const p = new StreamParser();
    const [ev] = collect(
      p.consume({
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    expect(ev).toEqual({ type: 'usage', promptTokens: 10, completionTokens: 5 });
  });

  it('maps finish_reason correctly', () => {
    const cases: Array<[string, string]> = [
      ['stop', 'stop'],
      ['length', 'length'],
      ['tool_calls', 'tool_use'],
      ['content_filter', 'stop'],
    ];
    for (const [input, expected] of cases) {
      const p = new StreamParser();
      collect(
        p.consume({
          choices: [{ delta: {}, finish_reason: input as 'stop' }],
        }),
      );
      expect(p.getDoneReason()).toBe(expected);
    }
  });
});

describe('parseSSEStream', () => {
  it('parses OpenAI-style SSE frames and stops on [DONE]', async () => {
    const encoder = new TextEncoder();
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      ': heartbeat comment\n\n',
      'data: [DONE]\n\n',
      'data: {"should":"ignored"}\n\n',
    ];
    async function* gen() {
      for (const f of frames) yield encoder.encode(f);
    }
    const chunks: unknown[] = [];
    for await (const c of parseSSEStream(gen())) chunks.push(c);
    expect(chunks).toHaveLength(2);
    expect((chunks[0] as any).choices[0].delta.content).toBe('Hi');
    expect((chunks[1] as any).choices[0].delta.content).toBe(' there');
  });

  it('handles frames split across chunks', async () => {
    const encoder = new TextEncoder();
    async function* gen() {
      yield encoder.encode('data: {"choi');
      yield encoder.encode('ces":[{"delta":{"content":"x"}}]}\n\n');
      yield encoder.encode('data: [DONE]\n\n');
    }
    const chunks: unknown[] = [];
    for await (const c of parseSSEStream(gen())) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as any).choices[0].delta.content).toBe('x');
  });

  it('silently drops corrupt JSON frames', async () => {
    const encoder = new TextEncoder();
    async function* gen() {
      yield encoder.encode('data: {broken\n\n');
      yield encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      yield encoder.encode('data: [DONE]\n\n');
    }
    const chunks: unknown[] = [];
    for await (const c of parseSSEStream(gen())) chunks.push(c);
    expect(chunks).toHaveLength(1);
  });
});

describe('partialJsonParse', () => {
  it('parses complete JSON', () => {
    expect(partialJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses incomplete object', () => {
    // partial-json should fill missing close brace
    expect(partialJsonParse('{"path":"a.ts"')).toEqual({ path: 'a.ts' });
  });

  it('returns null for empty/whitespace input', () => {
    expect(partialJsonParse('')).toBeNull();
    expect(partialJsonParse('   ')).toBeNull();
  });
});
