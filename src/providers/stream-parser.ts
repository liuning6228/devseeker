/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * OpenAI 兼容 SSE 流 → StreamEvent v2 增量转换器
 *
 * 来源：DESIGN §M1.6
 *
 * 职责：
 * 1. 解析 `data: {json}\n\n` SSE 帧
 * 2. 把 `choice.delta.content` → text_delta
 * 3. 把 `choice.delta.reasoning_content` → reasoning_delta（DeepSeek-R 双路径 K1）
 * 4. 把 `choice.delta.tool_calls[]` 拆成 tool_start / tool_args_delta / tool_end
 * 5. 把 `choice.finish_reason` → done
 * 6. 把 `usage` → usage 事件（含 cachedTokens）
 *
 * 不做的事：
 * - 不 parse 工具参数 JSON（留给 ToolRunner 完整接收后统一 parse，或用 partialJsonParse 提前渲染）
 * - 不做重试（由 DeepSeekProvider 外层处理）
 */

import { parse as parsePartialJson, Allow } from 'partial-json';
import type { DoneReason, StreamEvent } from './types.js';

// OpenAI/DeepSeek SSE Chunk 片段（只声明我们关心的字段）
interface SSEChunk {
  id?: string;
  object?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number; // DeepSeek 缓存命中
    prompt_cache_miss_tokens?: number;
  };
}

interface ToolCallAccumulator {
  id: string;
  index: number;
  name: string;
  /** 已累计的 arguments 字符串（未必是合法 JSON） */
  argsRaw: string;
  /** 是否已发出 tool_start（首次出现 name 时发） */
  started: boolean;
}

/**
 * 增量解析器状态机。
 * 一个实例对应一次 createMessage 调用。
 */
export class StreamParser {
  private toolCalls = new Map<number, ToolCallAccumulator>();
  private finishReason: DoneReason | null = null;

  /**
   * 消费一个 SSE Chunk（parsed JSON），产出 0 或多个 StreamEvent。
   */
  *consume(chunk: SSEChunk): Generator<StreamEvent> {
    // 1. usage（DeepSeek 流式末帧才带，或非流式 message 中）
    if (chunk.usage) {
      const promptTokens = chunk.usage.prompt_tokens ?? 0;
      const completionTokens = chunk.usage.completion_tokens ?? 0;
      const cachedTokens = chunk.usage.prompt_cache_hit_tokens;
      yield {
        type: 'usage',
        promptTokens,
        completionTokens,
        ...(cachedTokens !== undefined ? { cachedTokens } : {}),
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;

    const delta = choice.delta ?? {};
    const message = choice.message ?? {};

    // 2. reasoning_delta（K1 双路径：delta.reasoning_content 与 message.reasoning_content）
    const reasoning = delta.reasoning_content ?? message.reasoning_content;
    if (reasoning) {
      yield { type: 'reasoning_delta', text: reasoning };
    }

    // 3. text_delta（同样双路径兜底）
    const text = delta.content ?? message.content;
    if (text) {
      yield { type: 'text_delta', text };
    }

    // 4. tool_calls 增量
    if (delta.tool_calls && delta.tool_calls.length > 0) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        let acc = this.toolCalls.get(idx);

        // 首次出现该 index：建累加器
        if (!acc) {
          acc = {
            id: tc.id ?? `call_${idx}`,
            index: idx,
            name: tc.function?.name ?? '',
            argsRaw: '',
            started: false,
          };
          this.toolCalls.set(idx, acc);
        } else {
          // 后续 chunk 可能补全 id / name
          if (tc.id && !acc.id.startsWith('call_')) acc.id = tc.id;
          else if (tc.id) acc.id = tc.id;
          if (tc.function?.name && !acc.name) acc.name = tc.function.name;
        }

        // name 已知且首次发射：tool_start
        if (!acc.started && acc.name) {
          acc.started = true;
          yield { type: 'tool_start', id: acc.id, name: acc.name };
        }

        // arguments 增量
        const argsPart = tc.function?.arguments;
        if (argsPart) {
          acc.argsRaw += argsPart;
          // 仅在已 tool_start 之后发 args_delta（避免顺序错乱）
          if (acc.started) {
            yield { type: 'tool_args_delta', id: acc.id, partial: argsPart };
          }
        }
      }
    }

    // 5. finish_reason
    if (choice.finish_reason) {
      // 所有活跃 tool_call 发 tool_end
      for (const acc of this.toolCalls.values()) {
        if (acc.started) {
          yield { type: 'tool_end', id: acc.id };
        }
      }
      this.finishReason = mapFinishReason(choice.finish_reason);
    }
  }

  /**
   * 流结束时返回最终 done reason。
   * 由调用方在 usage 事件之后、error 事件之后统一发射 done。
   */
  getDoneReason(): DoneReason {
    return this.finishReason ?? 'stop';
  }

  /** 当前已积累的工具调用（供调试/日志） */
  snapshotToolCalls(): Array<{ id: string; name: string; argsRaw: string }> {
    return Array.from(this.toolCalls.values()).map((a) => ({
      id: a.id,
      name: a.name,
      argsRaw: a.argsRaw,
    }));
  }
}

function mapFinishReason(r: string): DoneReason {
  switch (r) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'stop';
    default:
      return 'stop';
  }
}

// ─────────── SSE 行解析器 ───────────

/**
 * 将 ReadableStream<Uint8Array> 的 SSE 流按 `data: ...` 帧切分。
 *
 * @yields 每帧的 JSON 对象；遇到 "data: [DONE]" 停止。
 */
export async function* parseSSEStream(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<SSEChunk> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const iter: AsyncIterable<Uint8Array> =
    typeof (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function'
      ? (stream as AsyncIterable<Uint8Array>)
      : readableStreamToAsyncIterable(stream as ReadableStream<Uint8Array>);

  for await (const chunk of iter) {
    buffer += decoder.decode(chunk, { stream: true });

    let nlIndex: number;
    // SSE 帧以 \n\n 结束；但我们按行处理更稳：每行 "data: ..."
    while ((nlIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nlIndex).replace(/\r$/, '');
      buffer = buffer.slice(nlIndex + 1);

      if (!line) continue; // 空行（帧分隔）
      if (line.startsWith(':')) continue; // SSE 注释
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      if (!payload) continue;

      try {
        yield JSON.parse(payload) as SSEChunk;
      } catch {
        // 损坏帧忽略，由上层 finish 事件兜底
      }
    }
  }
}

async function* readableStreamToAsyncIterable<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// ─────────── partial-json 便利封装 ───────────

/**
 * 对不完整 JSON 做宽松解析（DESIGN §M1.6 UI 提前渲染需求）。
 * 失败时返回 null 而不是 throw。
 */
export function partialJsonParse(s: string): unknown | null {
  if (!s || !s.trim()) return null;
  try {
    return parsePartialJson(s, Allow.ALL);
  } catch {
    return null;
  }
}
