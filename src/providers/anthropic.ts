/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Anthropic Provider（Claude 3.5 Sonnet / Haiku）
 *
 * 来源：DESIGN §M1.3
 *
 * 使用 Anthropic 原生 `/v1/messages` 协议（非 OpenAI 兼容），主要差异：
 * 1. 鉴权：`x-api-key` + `anthropic-version` 头（不是 Bearer）
 * 2. system 是独立字段，不在 messages[] 里
 * 3. tools schema 扁平化：`{name, description, input_schema}`（无 `type:function` 外包）
 * 4. assistant 消息的工具调用是 `content: [{type:"tool_use", id, name, input}]`
 * 5. tool 结果回传走 `role:"user"` + `content:[{type:"tool_result", tool_use_id, content}]`
 * 6. SSE 事件是粒度化的 `content_block_start/delta/stop` + `message_delta` + `message_stop`
 *
 * 默认：
 * - baseUrl: https://api.anthropic.com/v1
 * - model:   claude-3-5-sonnet-20241022
 *
 * 定价（2025Q4，USD / 百万 tokens）：
 * - Sonnet 3.5  输入 3 / 输出 15 / cache-read 0.3 / cache-write 3.75
 */

import { BaseProvider } from './base.js';
import type {
  Capability,
  CreateMessageOptions,
  DoneReason,
  Message,
  Pricing,
  ProbeResult,
  ProviderId,
  StreamEvent,
  ToolCall,
  ToolSchema,
  ContentPart,
} from './types.js';
import { AgentError, ErrorCodes, toAgentError } from '../core/errors/index.js';
import { computeBackoff, shouldRetry, sleepWithAbort, parseRetryAfter } from '../core/retry/backoff.js';
import { getLogger } from '../infra/logger.js';

const log = getLogger('provider.anthropic');

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';
const DEFAULT_TIMEOUT_MS = 120_000;
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** Anthropic 默认 max_tokens 必填，未显式传时用此值 */
  defaultMaxTokens?: number;
}

export class AnthropicProvider extends BaseProvider {
  readonly capabilities: readonly Capability[] = ['text', 'tool-use', 'vision', 'prompt-cache'];
  readonly contextWindow = 200_000;
  readonly pricing: Pricing = {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.3,
    currency: 'USD',
  };

  private apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly defaultMaxTokens: number;

  protected _defaultId(): ProviderId { return 'anthropic-claude'; }

  /** P1-1: 动态替换 API Key（同级多 Key 轮换） */
  override updateApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  constructor(cfg: AnthropicConfig) {
    super();
    if (!cfg.apiKey) {
      throw new AgentError({
        code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY,
        message: 'Anthropic apiKey is empty',
      });
    }
    this.apiKey = cfg.apiKey;
    this.baseUrl = (cfg.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = cfg.model?.trim() || DEFAULT_MODEL;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxTokens = cfg.defaultMaxTokens ?? 8192;
  }

  // ─────────── probe ───────────

  async probe(): Promise<ProbeResult> {
    // Anthropic 无独立 /models 端点，用一个极小 messages 请求做连通性探测
    const started = Date.now();
    try {
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/messages`,
        {
          method: 'POST',
          headers: this.authHeaders({ json: true }),
          body: JSON.stringify({
            model: this.model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          }),
        },
        10_000,
      );
      if (!res.ok) {
        const err = await this.responseToAgentError(res);
        return { ok: false, latencyMs: Date.now() - started, error: this.toProviderError(err) };
      }
      return { ok: true, latencyMs: Date.now() - started, model: this.model };
    } catch (e) {
      const err = toAgentError(e, ErrorCodes.PROVIDER_NET_UNREACHABLE);
      return { ok: false, latencyMs: Date.now() - started, error: this.toProviderError(err) };
    }
  }

  // ─────────── createMessage ───────────

  async *createMessage(options: CreateMessageOptions): AsyncIterable<StreamEvent> {
    const model = options.modelOverride ?? this.model;
    const body = this.buildRequestBody(options, model);

    let attempt = 0;
    let lastError: AgentError | null = null;

    while (true) {
      if (options.signal?.aborted) {
        yield {
          type: 'error',
          error: this.toProviderError(
            new AgentError({ code: ErrorCodes.TASK_LOOP_ABORTED, message: 'Aborted before request' }),
          ),
        };
        yield { type: 'done', reason: 'aborted' };
        return;
      }
      try {
        yield* this.streamOnce(body, this.timeoutMs, options.signal);
        return;
      } catch (e) {
        const err = toAgentError(e, ErrorCodes.PROVIDER_STREAM_BROKEN);
        lastError = err;
        if (!err.retryable || !shouldRetry(err.code, attempt)) break;
        const retryAfterMs =
          typeof err.context?.retryAfterMs === 'number'
            ? (err.context.retryAfterMs as number)
            : undefined;
        const wait = computeBackoff(err.code, attempt, retryAfterMs);
        log.warn(
          { code: err.code, attempt: attempt + 1, waitMs: wait },
          'Anthropic request failed, retrying',
        );
        try {
          await sleepWithAbort(wait, options.signal);
        } catch {
          yield {
            type: 'error',
            error: this.toProviderError(
              new AgentError({ code: ErrorCodes.TASK_LOOP_ABORTED, message: 'Aborted during backoff' }),
            ),
          };
          yield { type: 'done', reason: 'aborted' };
          return;
        }
        attempt++;
      }
    }

    const finalError =
      lastError ??
      new AgentError({ code: ErrorCodes.PROVIDER_STREAM_BROKEN, message: 'Unknown stream error' });
    yield { type: 'error', error: this.toProviderError(finalError) };
    yield { type: 'done', reason: 'error' };
  }

  private async *streamOnce(
    body: Record<string, unknown>,
    timeoutMs: number,
    externalSignal: AbortSignal | undefined,
  ): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onExternalAbort = () => controller.abort(new Error('external_abort'));
    externalSignal?.addEventListener('abort', onExternalAbort);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: this.authHeaders({ json: true, stream: true }),
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      if (externalSignal?.aborted) {
        throw new AgentError({ code: ErrorCodes.TASK_LOOP_ABORTED, message: 'Aborted' });
      }
      if ((e as Error).message === 'timeout') {
        throw new AgentError({
          code: ErrorCodes.PROVIDER_NET_TIMEOUT,
          message: `Anthropic request exceeded ${timeoutMs}ms`,
          cause: e,
        });
      }
      throw toAgentError(e, ErrorCodes.PROVIDER_NET_UNREACHABLE);
    }

    if (!res.ok) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      throw await this.responseToAgentError(res);
    }
    if (!res.body) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      throw new AgentError({
        code: ErrorCodes.PROVIDER_STREAM_BROKEN,
        message: 'Anthropic response has no body',
      });
    }

    const parser = new AnthropicStreamParser();
    try {
      for await (const evt of parseAnthropicSSE(res.body as ReadableStream<Uint8Array>)) {
        for (const out of parser.consume(evt)) yield out;
      }
      yield { type: 'done', reason: parser.getDoneReason() };
    } catch (e) {
      if (externalSignal?.aborted) {
        yield {
          type: 'error',
          error: this.toProviderError(
            new AgentError({ code: ErrorCodes.TASK_LOOP_ABORTED, message: 'Aborted mid-stream' }),
          ),
        };
        yield { type: 'done', reason: 'aborted' };
        return;
      }
      throw toAgentError(e, ErrorCodes.PROVIDER_STREAM_BROKEN);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  // ─────────── 请求构造 ───────────

  private authHeaders(opts: { json?: boolean; stream?: boolean } = {}): Record<string, string> {
    const h: Record<string, string> = {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
    if (opts.json) h['Content-Type'] = 'application/json';
    if (opts.stream) h['Accept'] = 'text/event-stream';
    return h;
  }

  private buildRequestBody(options: CreateMessageOptions, model: string): Record<string, unknown> {
    const { system, messages } = splitSystemAndMessages(options.messages);

    const body: Record<string, unknown> = {
      model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      messages: messages.map(toAnthropicMessage),
    };
    if (system) body.system = system;
    if (options.temperature != null) body.temperature = options.temperature;
    if (options.topP != null) body.top_p = options.topP;
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toAnthropicTool);
      if (options.toolChoice) body.tool_choice = toAnthropicToolChoice(options.toolChoice);
    }
    return body;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async responseToAgentError(res: Response): Promise<AgentError> {
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* ignore */
    }
    const snippet = text.slice(0, 500);

    // P2-1: 尝试解析 Anthropic JSON error body 以获取 error.type
    let errorType = '';
    try {
      const body = JSON.parse(text);
      errorType = body?.error?.type ?? '';
    } catch {
      /* not JSON */
    }

    if (res.status === 401 || res.status === 403) {
      // Anthropic 401: invalid_api_key / 403: forbidden
      return new AgentError({
        code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY,
        message: `Anthropic auth failed (${res.status}, type=${errorType || 'unknown'}): ${snippet}`,
      });
    }
    if (res.status === 402) {
      return new AgentError({
        code: ErrorCodes.PROVIDER_BILLING_INSUFFICIENT,
        message: `Anthropic insufficient quota: ${snippet}`,
      });
    }
    if (res.status === 404) {
      return new AgentError({
        code: ErrorCodes.PROVIDER_MODEL_NOT_FOUND,
        message: `Anthropic model not found: ${snippet}`,
      });
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      const retryAfterMs = parseRetryAfter(retryAfter);
      return new AgentError({
        code: ErrorCodes.PROVIDER_RATE_LIMITED,
        message: `Anthropic rate limited (retry-after=${retryAfter ?? 'n/a'}, type=${errorType || 'unknown'}): ${snippet}`,
        context: retryAfterMs !== undefined ? { retryAfter, retryAfterMs } : { retryAfter },
      });
    }
    // P2-1: Anthropic 特有 529 overloaded（api_overloaded_error）
    if (res.status === 529 || errorType === 'api_overloaded_error') {
      return new AgentError({
        code: ErrorCodes.PROVIDER_SERVER_OVERLOADED,
        message: `Anthropic server overloaded (529, type=${errorType || 'unknown'}): ${snippet}`,
      });
    }
    if (res.status >= 500) {
      return new AgentError({
        code: ErrorCodes.PROVIDER_SERVER_5XX,
        message: `Anthropic server error ${res.status} (type=${errorType || 'unknown'}): ${snippet}`,
      });
    }
    if (res.status === 400) {
      // P2-1: 根据 Anthropic error.type 精准分类
      if (errorType === 'invalid_request_error' && /context.*length|too.*long|max.*tokens/i.test(text)) {
        return new AgentError({
          code: ErrorCodes.PROVIDER_RESP_CONTEXT_OVERFLOW,
          message: `Anthropic context overflow (type=${errorType}): ${snippet}`,
        });
      }
      if (errorType === 'invalid_request_error') {
        // 其他 400 invalid_request_error → format error（消息格式错误）
        return new AgentError({
          code: ErrorCodes.PROVIDER_BAD_REQUEST,
          message: `Anthropic bad request (type=${errorType}): ${snippet}`,
        });
      }
      if (/context.*length|too.*long|max.*tokens/i.test(text)) {
        return new AgentError({
          code: ErrorCodes.PROVIDER_RESP_CONTEXT_OVERFLOW,
          message: `Anthropic context overflow: ${snippet}`,
        });
      }
      if (/content.*policy|blocked|safety/i.test(text)) {
        return new AgentError({
          code: ErrorCodes.PROVIDER_RESP_CONTENT_FILTERED,
          message: `Anthropic content filtered: ${snippet}`,
        });
      }
    }
    return new AgentError({
      code: ErrorCodes.PROVIDER_STREAM_BROKEN,
      message: `Anthropic HTTP ${res.status} (type=${errorType || 'unknown'}): ${snippet}`,
    });
  }
}

// ─────────── 消息/工具映射 ───────────

/**
 * Anthropic 要求 system 是独立字段，不在 messages 里。
 * 取首个 role:system 消息（可能多段拼接），其余剔除。
 */
export function splitSystemAndMessages(messages: Message[]): {
  system: string | undefined;
  messages: Message[];
} {
  const systems: string[] = [];
  const rest: Message[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') systems.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const p of m.content) if (p.type === 'text') systems.push(p.text);
      }
    } else {
      rest.push(m);
    }
  }
  return { system: systems.length ? systems.join('\n\n') : undefined, messages: rest };
}

/**
 * Message → Anthropic messages[] item
 *
 * 特殊处理：
 * - assistant 带 toolCalls → content: [{type:"text",text}, {type:"tool_use", ...}]
 * - tool role → role:"user", content:[{type:"tool_result", tool_use_id, content}]
 */
export function toAnthropicMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: typeof m.content === 'string' ? m.content : stringifyContent(m.content),
        },
      ],
    };
  }

  if (m.role === 'assistant') {
    const blocks: Array<Record<string, unknown>> = [];
    const textContent = typeof m.content === 'string' ? m.content : stringifyContent(m.content);
    if (textContent) blocks.push({ type: 'text', text: textContent });
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        let input: unknown = {};
        try {
          input = tc.argsRaw ? JSON.parse(tc.argsRaw) : {};
        } catch {
          input = {}; // argsRaw 非法 JSON 时用空对象兜底
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
    }
    return { role: 'assistant', content: blocks.length ? blocks : '' };
  }

  // user role
  if (typeof m.content === 'string') {
    return { role: 'user', content: m.content };
  }
  if (Array.isArray(m.content)) {
    return {
      role: 'user',
      content: m.content.map((p: ContentPart) => {
        if (p.type === 'text') return { type: 'text', text: p.text };
        // image_url → image（base64 或 url）
        const url = p.image_url.url;
        if (url.startsWith('data:')) {
          // data:image/png;base64,xxx
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            return {
              type: 'image',
              source: { type: 'base64', media_type: match[1], data: match[2] },
            };
          }
        }
        return { type: 'image', source: { type: 'url', url } };
      }),
    };
  }
  return { role: 'user', content: '' };
}

function stringifyContent(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p.type === 'text' ? p.text : `[image]`))
    .join('');
}

export function toAnthropicTool(t: ToolSchema): Record<string, unknown> {
  return {
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  };
}

export function toAnthropicToolChoice(choice: CreateMessageOptions['toolChoice']): unknown {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return undefined; // Anthropic 无 none，由调用方在 tools 不传即可
  if (choice && typeof choice === 'object' && choice.type === 'function') {
    return { type: 'tool', name: choice.function.name };
  }
  return { type: 'auto' };
}

// ─────────── Anthropic SSE Parser ───────────

/**
 * Anthropic 粒度化 SSE 事件（仅我们关心的字段）。
 */
interface AnthropicSSEEvent {
  event: string;
  data: AnthropicEventData;
}

type AnthropicEventData =
  | { type: 'message_start'; message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } } }
  | { type: 'content_block_start'; index: number; content_block: { type: 'text' | 'tool_use'; id?: string; name?: string; text?: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta' | 'input_json_delta'; text?: string; partial_json?: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: string }; usage?: { output_tokens?: number } }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } };

export class AnthropicStreamParser {
  // index → 是否是 tool_use block（用于 content_block_delta 分发）
  private blockKind = new Map<number, 'text' | 'tool_use'>();
  private blockToolId = new Map<number, string>();
  private blockToolName = new Map<number, string>();
  private finishReason: DoneReason | null = null;
  private inputTokens = 0;
  private cachedTokens: number | undefined;
  private outputTokens = 0;
  private usageSent = false;

  *consume(evt: AnthropicSSEEvent): Generator<StreamEvent> {
    const data = evt.data;
    switch (data.type) {
      case 'message_start': {
        const u = data.message?.usage;
        if (u) {
          this.inputTokens = u.input_tokens ?? 0;
          this.cachedTokens = u.cache_read_input_tokens;
        }
        break;
      }
      case 'content_block_start': {
        const { index, content_block } = data;
        if (content_block.type === 'text') {
          this.blockKind.set(index, 'text');
        } else if (content_block.type === 'tool_use') {
          this.blockKind.set(index, 'tool_use');
          const id = content_block.id ?? `toolu_${index}`;
          const name = content_block.name ?? '';
          this.blockToolId.set(index, id);
          this.blockToolName.set(index, name);
          yield { type: 'tool_start', id, name };
        }
        break;
      }
      case 'content_block_delta': {
        const kind = this.blockKind.get(data.index);
        if (kind === 'text' && data.delta.type === 'text_delta' && data.delta.text) {
          yield { type: 'text_delta', text: data.delta.text };
        } else if (kind === 'tool_use' && data.delta.type === 'input_json_delta' && data.delta.partial_json) {
          const id = this.blockToolId.get(data.index);
          if (id) {
            yield { type: 'tool_args_delta', id, partial: data.delta.partial_json };
          }
        }
        break;
      }
      case 'content_block_stop': {
        const kind = this.blockKind.get(data.index);
        if (kind === 'tool_use') {
          const id = this.blockToolId.get(data.index);
          if (id) yield { type: 'tool_end', id };
        }
        break;
      }
      case 'message_delta': {
        if (data.delta?.stop_reason) {
          this.finishReason = mapAnthropicStopReason(data.delta.stop_reason);
        }
        if (data.usage?.output_tokens != null) {
          this.outputTokens = data.usage.output_tokens;
        }
        break;
      }
      case 'message_stop': {
        if (!this.usageSent) {
          this.usageSent = true;
          yield {
            type: 'usage',
            promptTokens: this.inputTokens,
            completionTokens: this.outputTokens,
            ...(this.cachedTokens !== undefined ? { cachedTokens: this.cachedTokens } : {}),
          };
        }
        break;
      }
      case 'error': {
        throw new AgentError({
          code: ErrorCodes.PROVIDER_STREAM_BROKEN,
          message: `Anthropic stream error: ${data.error.type} - ${data.error.message}`,
        });
      }
      case 'ping':
      default:
        break;
    }
  }

  getDoneReason(): DoneReason {
    return this.finishReason ?? 'stop';
  }
}

function mapAnthropicStopReason(reason: string): DoneReason {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_use';
    case 'stop_sequence':
      return 'stop';
    default:
      return 'stop';
  }
}

/**
 * 解析 Anthropic SSE：每帧由 `event: X\ndata: {json}\n\n` 组成
 */
export async function* parseAnthropicSSE(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<AnthropicSSEEvent> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const iter: AsyncIterable<Uint8Array> =
    typeof (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function'
      ? (stream as AsyncIterable<Uint8Array>)
      : readableStreamToAsyncIterable(stream as ReadableStream<Uint8Array>);

  for await (const chunk of iter) {
    buffer += decoder.decode(chunk, { stream: true });

    let frameEnd: number;
    while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);

      let eventName = '';
      let dataLine = '';
      for (const line of frame.split('\n')) {
        const trimmed = line.replace(/\r$/, '');
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed.startsWith('event:')) eventName = trimmed.slice(6).trim();
        else if (trimmed.startsWith('data:')) {
          const v = trimmed.slice(5).trim();
          dataLine = dataLine ? dataLine + '\n' + v : v;
        }
      }
      if (!dataLine) continue;
      try {
        const data = JSON.parse(dataLine) as AnthropicEventData;
        yield { event: eventName || data.type || '', data };
      } catch {
        // 损坏帧忽略
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
