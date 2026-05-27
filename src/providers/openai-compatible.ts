/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * OpenAICompatibleProvider —— 通用 OpenAI 兼容基类
 *
 * 适用：DeepSeek / OpenAI / Qwen（DashScope 兼容模式）等所有走
 * `POST /v1/chat/completions` + SSE 协议的 Provider。
 *
 * 来源：DESIGN §M1.2 / §M1.6
 *
 * 契约：
 * - 子类只需提供：id / capabilities / contextWindow / pricing / baseUrl / defaultModel
 * - 可选覆盖：reasoningModel / forbiddenKeys / buildAuthHeaders / modelForRequest
 * - 本基类负责：请求循环 / 重试 / 超时 / K2 null content / K3 参数过滤 / HTTP 错误归一化 / SSE 解析
 *
 * 三坑兜底（DeepSeek 现成经验）：
 * - K1 reasoning_content 双路径 —— 由 stream-parser 天然支持
 * - K2 content:null 自动改 "" —— sanitizeMessages
 * - K3 参数白名单过滤 —— FORBIDDEN_PARAM_KEYS 子类可覆盖
 */

import { BaseProvider } from './base.js';
import type {
  Capability,
  CreateMessageOptions,
  Message,
  Pricing,
  ProbeResult,
  ProviderId,
  StreamEvent,
  ToolCall,
} from './types.js';
import { StreamParser, parseSSEStream } from './stream-parser.js';
import { AgentError, ErrorCodes, toAgentError, isSocketError } from '../core/errors/index.js';
import { computeBackoff, shouldRetry, sleepWithAbort, parseRetryAfter } from '../core/retry/backoff.js';
import { ReasoningCache } from '../core/cache/reasoning-cache.js';
import { getLogger } from '../infra/logger.js';

const log = getLogger('provider.oai-compat');

const DEFAULT_TIMEOUT_MS = 300_000;   // 5 分钟（写长文档场景需要更长时间）
const DEFAULT_REASONING_TIMEOUT_MS = 600_000;

/**
 * 供应商粒度的 K3 默认黑名单（可覆盖）：这些参数 OpenAI 不接受或某些厂商 400。
 */
const DEFAULT_FORBIDDEN_KEYS = new Set(['reasoning_effort', 'seed_mode']);

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  reasoningModel?: string;
  timeoutMs?: number;
  reasoningTimeoutMs?: number;
  /** W15.2 · reasoning 缓存 TTL（毫秒）。默认 5 分钟。 */
  reasoningCacheTtlMs?: number;
}

/**
 * OpenAI 兼容 Provider 抽象基类。
 * 子类必填：`id` / `capabilities` / `contextWindow` / `pricing` / `defaultBaseUrl` / `defaultModel`
 */
export abstract class OpenAICompatibleProvider extends BaseProvider {
  // id 由 BaseProvider getter 提供，子类通过 _defaultId() 提供默认值
  abstract readonly capabilities: readonly Capability[];
  abstract readonly contextWindow: number;
  abstract readonly pricing: Pricing;
  protected abstract readonly defaultBaseUrl: string;
  protected abstract readonly defaultModel: string;

  protected apiKey: string;
  protected readonly baseUrl: string;
  protected readonly model: string;
  /**
   * reasoning 模型 id（W15.5 Auto-Thinking-Router 需公开供 panel 读取）。
   * 仅对具备 reasoning capability 的子类有效（如 DeepSeek 的 deepseek-reasoner）。
   */
  readonly reasoningModel?: string;
  protected readonly timeoutMs: number;
  protected readonly reasoningTimeoutMs: number;
  /** W15.2 · reasoning 结果缓存 */
  protected readonly reasoningCache: ReasoningCache;

  constructor(cfg: OpenAICompatibleConfig) {
    super();
    if (!cfg.apiKey) {
      throw new AgentError({
        code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY,
        message: `${this.constructor.name}: apiKey is empty`,
      });
    }
    this.apiKey = cfg.apiKey;
    // baseUrl / model 需延迟到 subclass 字段初始化后才能 fallback
    this.baseUrl = ((cfg.baseUrl ?? '') || '').trim().replace(/\/+$/, '');
    this.model = (cfg.model ?? '').trim();
    this.reasoningModel = cfg.reasoningModel?.trim() || undefined;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.reasoningTimeoutMs = cfg.reasoningTimeoutMs ?? DEFAULT_REASONING_TIMEOUT_MS;
    this.reasoningCache = new ReasoningCache({ ttlMs: cfg.reasoningCacheTtlMs });
  }

  /** 真实使用的 baseUrl（延迟 fallback 到子类 defaultBaseUrl） */
  protected resolvedBaseUrl(): string {
    return this.baseUrl || this.defaultBaseUrl.replace(/\/+$/, '');
  }
  protected resolvedModel(): string {
    return this.model || this.defaultModel;
  }

  /** 子类可覆盖参数黑名单（默认 reasoning_effort / seed_mode） */
  protected forbiddenKeys(): Set<string> {
    return DEFAULT_FORBIDDEN_KEYS;
  }

  /** 子类可覆盖鉴权头（默认 Bearer） */
  protected buildAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
  }

  /** P1-1: 动态替换 API Key（同级多 Key 轮换） */
  override updateApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /** 是否是推理模型（超时更长） */
  protected isReasoningModel(model: string): boolean {
    return !!this.reasoningModel && model === this.reasoningModel;
  }

  // ─────────── probe ───────────

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const res = await this.fetchWithTimeout(
        `${this.resolvedBaseUrl()}/models`,
        { method: 'GET', headers: this.buildAuthHeaders() },
        10_000,
      );
      if (!res.ok) {
        const err = await this.responseToAgentError(res);
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: this.toProviderError(err),
        };
      }
      return { ok: true, latencyMs: Date.now() - started, model: this.resolvedModel() };
    } catch (e) {
      const err = toAgentError(e, ErrorCodes.PROVIDER_NET_UNREACHABLE);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: this.toProviderError(err),
      };
    }
  }

  // ─────────── createMessage ───────────

  async *createMessage(options: CreateMessageOptions): AsyncIterable<StreamEvent> {
    const model = options.modelOverride ?? this.resolvedModel();
    const timeoutMs = this.isReasoningModel(model) ? this.reasoningTimeoutMs : this.timeoutMs;

    const sanitized = sanitizeMessages(options.messages);
    const body = this.buildRequestBody(sanitized, options, model);

    // W15.2 · reasoning cache：仅对推理模型启用
    const cacheKey = this.isReasoningModel(model) ? this.reasoningCache.computeKey(sanitized) : undefined;

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
        if (cacheKey) {
          yield* this.cachedStream(body, timeoutMs, options.signal, cacheKey);
        } else {
          yield* this.streamOnce(body, timeoutMs, options.signal);
        }
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
          { providerId: this.id, code: err.code, attempt: attempt + 1, waitMs: wait },
          'Provider request failed, retrying',
        );
        try {
          await sleepWithAbort(wait, options.signal);
        } catch {
          // 取消在退避期间发生 → 跳出循环以 abort 事件结束
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

    // ── 流式重试全部失败 → 降级为非流式请求（W15.6 STREAM_BROKEN 兜底） ──
    // 典型场景：DeepSeek API 不稳定，SSE 连接在 300-600ms 内反复断开。
    // 非流式请求绕过 SSE 解析，直接获取完整 JSON 响应。
    if (lastError?.code === ErrorCodes.PROVIDER_STREAM_BROKEN) {
      log.info({ providerId: this.id }, 'All streaming retries failed, falling back to non-streaming request');
      try {
        yield* this.nonStreamingRequest(body, timeoutMs, options.signal);
        return;
      } catch (fallbackErr) {
        log.warn(
          { providerId: this.id, err: String(fallbackErr) },
          'Non-streaming fallback also failed',
        );
        // W15.7 · 保留 fallback 的原始错误码（如 PROVIDER_BAD_REQUEST），
        // 不覆盖为 STREAM_BROKEN——HTTP 400 消息格式错误不可重试
        lastError = fallbackErr instanceof AgentError ? fallbackErr : toAgentError(fallbackErr, ErrorCodes.PROVIDER_STREAM_BROKEN);
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
      const url = `${this.resolvedBaseUrl()}/chat/completions`;
      log.info({ providerId: this.id, model: body.model, url }, 'Fetching stream');
      res = await fetch(url, {
        method: 'POST',
        headers: { ...this.buildAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
          message: `${this.id} request exceeded ${timeoutMs}ms`,
          cause: e,
        });
      }
      // P0-5: Socket 错误全覆盖（11 种）→ 统一归为 NET_TIMEOUT
      if (isSocketError(e)) {
        const socketCode = (e as any).code ?? (e as any).cause?.code ?? 'UNKNOWN';
        throw new AgentError({
          code: ErrorCodes.PROVIDER_NET_TIMEOUT,
          message: `${this.id} socket error (${socketCode}): connection reset/refused`,
          cause: e,
        });
      }
      throw toAgentError(e, ErrorCodes.PROVIDER_NET_UNREACHABLE);
    }

    if (!res.ok) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      log.warn({ providerId: this.id, status: res.status, statusText: res.statusText }, 'Stream request failed');
      throw await this.responseToAgentError(res);
    }

    if (!res.body) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      throw new AgentError({
        code: ErrorCodes.PROVIDER_STREAM_BROKEN,
        message: `${this.id} response has no body`,
      });
    }

    log.info({ providerId: this.id, status: res.status }, 'Stream response received');

    const parser = new StreamParser();
    let chunksReceived = 0;
    // W15.10 · 流式心跳超时：15 秒内没收到任何 chunk 就判定断流。
    // 不使用 controller.abort()（在 Node.js undici 中可能导致 unhandled stream error 崩溃），
    // 改用 chunkTimeout flag + 手动 break 安全退出 for-await 循环。
    const CHUNK_TIMEOUT_MS = 15_000;
    let chunkTimedOut = false;
    let timerId: ReturnType<typeof setTimeout> = setTimeout(() => {
      chunkTimedOut = true;
      // 安全 abort：try-catch 包裹防止 undici 内部错误导致 extension host 崩溃
      try { controller.abort(new Error('chunk_timeout')); } catch { /* ignore */ }
    }, CHUNK_TIMEOUT_MS);
    const refreshChunkTimer = () => {
      clearTimeout(timerId);
      timerId = setTimeout(() => {
        chunkTimedOut = true;
        try { controller.abort(new Error('chunk_timeout')); } catch { /* ignore */ }
      }, CHUNK_TIMEOUT_MS);
    };
    try {
      for await (const chunk of parseSSEStream(res.body as ReadableStream<Uint8Array>)) {
        if (chunkTimedOut) break;
        chunksReceived++;
        // 每收到 chunk 就重置超时——连接仍然活跃
        refreshChunkTimer();
        for (const ev of parser.consume(chunk)) {
          yield ev;
        }
      }

      if (chunkTimedOut) {
        // chunk 超时走断流逻辑
        log.warn(
          {
            providerId: this.id,
            chunksReceived,
            toolCallsParsed: parser.snapshotToolCalls().length,
          },
          'STREAM_CHUNK_TIMEOUT: no SSE chunk received within 15s, stream stalled',
        );
        throw new AgentError({
          code: ErrorCodes.PROVIDER_STREAM_BROKEN,
          message: `${this.id} chunk_timeout after ${chunksReceived} chunks`,
        });
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
      // 检测 chunk_timeout（可能从 abort 异常路径进来，也可能从上面 throw 进来）
      if (chunkTimedOut || (e as Error).message?.includes('chunk_timeout')) {
        log.warn(
          {
            providerId: this.id,
            chunksReceived,
            toolCallsParsed: parser.snapshotToolCalls().length,
          },
          'STREAM_CHUNK_TIMEOUT: stream stalled, triggering STREAM_BROKEN retry',
        );
      }
      // W15.6 · 记录断流诊断信息
      const snapshot = parser.snapshotToolCalls();
      log.warn(
        {
          providerId: this.id,
          chunksReceived,
          toolCallsParsed: snapshot.length,
          toolCallNames: snapshot.map((tc) => tc.name),
          originalError: (e as Error)?.message ?? String(e),
        },
        'STREAM_BROKEN: SSE stream interrupted mid-parse',
      );
      throw toAgentError(e, ErrorCodes.PROVIDER_STREAM_BROKEN);
    } finally {
      clearTimeout(timerId);
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  // ─────────── W15.6 · STREAM_BROKEN 非流式兜底 ───────────

  /**
   * 当流式请求全部失败（STREAM_BROKEN）时的降级方案：
   * 用 `stream: false` 发送请求，直接获取完整 JSON 响应，
   * 然后将结果转化为标准 StreamEvent 序列。
   *
   * 优势：绕过 SSE 解析，即使 API 端流式连接不稳定也能拿到完整响应。
   * 劣势：无增量渲染、等待时间更长，但作为兜底可接受。
   */
  private async *nonStreamingRequest(
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
      // 构建 non-streaming body
      const nsBody = { ...body, stream: false };
      delete (nsBody as Record<string, unknown>).stream_options;

      res = await fetch(`${this.resolvedBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { ...this.buildAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(nsBody),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      if (externalSignal?.aborted) {
        yield {
          type: 'error',
          error: this.toProviderError(
            new AgentError({ code: ErrorCodes.TASK_LOOP_ABORTED, message: 'Aborted' }),
          ),
        };
        yield { type: 'done', reason: 'aborted' };
        return;
      }
      if ((e as Error).message === 'timeout') {
        throw new AgentError({
          code: ErrorCodes.PROVIDER_NET_TIMEOUT,
          message: `${this.id} non-streaming request exceeded ${timeoutMs}ms`,
          cause: e,
        });
      }
      // P0-5: Socket 错误全覆盖（11 种）→ 统一归为 NET_TIMEOUT
      if (isSocketError(e)) {
        const socketCode = (e as any).code ?? (e as any).cause?.code ?? 'UNKNOWN';
        throw new AgentError({
          code: ErrorCodes.PROVIDER_NET_TIMEOUT,
          message: `${this.id} socket error (${socketCode}) in non-streaming request`,
          cause: e,
        });
      }
      throw toAgentError(e, ErrorCodes.PROVIDER_NET_UNREACHABLE);
    }

    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);

    if (!res.ok) {
      throw await this.responseToAgentError(res);
    }

    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      throw new AgentError({
        code: ErrorCodes.PROVIDER_STREAM_BROKEN,
        message: `${this.id} non-streaming response JSON parse failed: ${String(e)}`,
      });
    }

    // ── 解析非流式响应 → StreamEvent 序列 ──
    const choice = (json.choices as Array<Record<string, unknown>>)?.[0];
    if (!choice) {
      throw new AgentError({
        code: ErrorCodes.PROVIDER_STREAM_BROKEN,
        message: `${this.id} non-streaming response has no choices`,
      });
    }

    const message = (choice.message ?? {}) as Record<string, unknown>;

    // reasoning_content（DeepSeek K1 双路径）
    if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
      yield { type: 'reasoning_delta', text: message.reasoning_content };
    }

    // text content
    if (typeof message.content === 'string' && message.content) {
      yield { type: 'text_delta', text: message.content };
    }

    // tool_calls
    const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const tcId = (tc.id as string) ?? `call_fallback_${toolCalls.indexOf(tc)}`;
        const func = tc.function as Record<string, unknown> | undefined;
        const tcName = (func?.name as string) ?? '';
        const tcArgs = (func?.arguments as string) ?? '';

        yield { type: 'tool_start', id: tcId, name: tcName };
        if (tcArgs) {
          yield { type: 'tool_args_delta', id: tcId, partial: tcArgs };
        }
        yield { type: 'tool_end', id: tcId };
      }
    }

    // usage
    const usage = json.usage as Record<string, unknown> | undefined;
    if (usage) {
      const promptTokens = (usage.prompt_tokens as number) ?? 0;
      const completionTokens = (usage.completion_tokens as number) ?? 0;
      const cachedTokens = usage.prompt_cache_hit_tokens as number | undefined;
      yield {
        type: 'usage',
        promptTokens,
        completionTokens,
        ...(cachedTokens !== undefined ? { cachedTokens } : {}),
      };
    }

    // done
    const finishReason = (choice.finish_reason as string) ?? 'stop';
    const doneReason: string = finishReason === 'tool_calls' ? 'tool_use' : finishReason === 'length' ? 'length' : 'stop';
    yield { type: 'done', reason: doneReason as 'stop' | 'length' | 'tool_use' };
  }

  // ─────────── W15.2 · reasoning cache ───────────

  /**
   * 包装 streamOnce：缓存命中时直接 replay；未命中时边消费边收集，
   * 流成功完成（done 且 reason ≠ error/aborted）后写入缓存。
   */
  private async *cachedStream(
    body: Record<string, unknown>,
    timeoutMs: number,
    externalSignal: AbortSignal | undefined,
    cacheKey: string,
  ): AsyncGenerator<StreamEvent> {
    const cached = this.reasoningCache.get(cacheKey);
    if (cached) {
      log.info({ keyPreview: cacheKey.slice(0, 8) }, 'reasoning cache hit');
      for (const ev of cached) {
        if (externalSignal?.aborted) {
          yield { type: 'done', reason: 'aborted' };
          return;
        }
        yield ev;
      }
      return;
    }

    const events: StreamEvent[] = [];
    for await (const ev of this.streamOnce(body, timeoutMs, externalSignal)) {
      events.push(ev);
      yield ev;
    }

    const last = events[events.length - 1];
    if (last && last.type === 'done' && last.reason !== 'error' && last.reason !== 'aborted') {
      this.reasoningCache.set(cacheKey, events);
      log.info({ keyPreview: cacheKey.slice(0, 8), events: events.length }, 'reasoning cache stored');
    }
  }

  // ─────────── 请求构造 ───────────

  private buildRequestBody(
    messages: Message[],
    options: CreateMessageOptions,
    model: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.toolChoice) body.tool_choice = options.toolChoice;
    }
    if (options.maxTokens != null) body.max_tokens = options.maxTokens;
    if (options.temperature != null) body.temperature = options.temperature;
    if (options.topP != null) body.top_p = options.topP;

    const forbidden = this.forbiddenKeys();
    for (const k of Object.keys(body)) {
      if (forbidden.has(k)) delete body[k];
    }
    return body;
  }

  protected async fetchWithTimeout(
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

  protected async responseToAgentError(res: Response): Promise<AgentError> {
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* ignore */
    }
    const snippet = text.slice(0, 500);

    if (res.status === 401 || res.status === 403) {
      return new AgentError({
        code: ErrorCodes.PROVIDER_AUTH_INVALID_API_KEY,
        message: `${this.id} auth failed (${res.status}): ${snippet}`,
      });
    }
    if (res.status === 402) {
      return new AgentError({
        code: ErrorCodes.PROVIDER_BILLING_INSUFFICIENT,
        message: `${this.id} insufficient quota: ${snippet}`,
      });
    }
    if (res.status === 404) {
      return new AgentError({
        code: ErrorCodes.PROVIDER_MODEL_NOT_FOUND,
        message: `${this.id} model not found: ${snippet}`,
      });
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      const retryAfterMs = parseRetryAfter(retryAfter);
      // 检测每日配额耗尽（如 OpenRouter free-models-per-day）
      // 这类 429 不可重试，应立即 failover 而非浪费 5 次退避等待
      const isDailyQuota = /free-models-per-day|daily.*quota|daily.*limit|X-RateLimit-Remaining.*0/i.test(snippet);
      if (isDailyQuota) {
        log.warn(
          { providerId: this.id, snippet: snippet.slice(0, 200) },
          '429 detected as daily quota exhaustion — not retryable, will failover immediately',
        );
        return new AgentError({
          code: ErrorCodes.PROVIDER_DAILY_QUOTA_EXCEEDED,
          message: `${this.id} daily quota exhausted: ${snippet}`,
          context: retryAfterMs !== undefined ? { retryAfter, retryAfterMs } : { retryAfter },
        });
      }
      return new AgentError({
        code: ErrorCodes.PROVIDER_RATE_LIMITED,
        message: `${this.id} rate limited (retry-after=${retryAfter ?? 'n/a'}): ${snippet}`,
        context: retryAfterMs !== undefined ? { retryAfter, retryAfterMs } : { retryAfter },
      });
    }
    // P2-1: 529 overloaded（部分 OpenAI 兼容 API 如 DeepSeek 可能返回）
    if (res.status === 529) {
      return new AgentError({
        code: ErrorCodes.PROVIDER_SERVER_OVERLOADED,
        message: `${this.id} server overloaded (529): ${snippet}`,
      });
    }
    if (res.status >= 500) {
      return new AgentError({
        code: ErrorCodes.PROVIDER_SERVER_5XX,
        message: `${this.id} server error ${res.status}: ${snippet}`,
      });
    }
    if (res.status === 400) {
      if (/context.*length|max.*tokens|too.*long/i.test(text)) {
        return new AgentError({
          code: ErrorCodes.PROVIDER_RESP_CONTEXT_OVERFLOW,
          message: `${this.id} context overflow: ${snippet}`,
        });
      }
      if (/content.*filter|safety/i.test(text)) {
        return new AgentError({
          code: ErrorCodes.PROVIDER_RESP_CONTENT_FILTERED,
          message: `${this.id} content filtered: ${snippet}`,
        });
      }
      // W15.6b: HTTP 400 消息格式错误（如 tool_calls 缺少对应 tool 回复）不可重试
      return new AgentError({
        code: ErrorCodes.PROVIDER_BAD_REQUEST,
        message: `${this.id} HTTP 400: ${snippet}`,
      });
    }
    return new AgentError({
      code: ErrorCodes.PROVIDER_STREAM_BROKEN,
      message: `${this.id} HTTP ${res.status}: ${snippet}`,
    });
  }
}

// ─────────── 公共 helpers ───────────

/**
 * K2: assistant.content == null → ""
 * K3: 清理不完整的 tool_calls 配对 — 如果 assistant 消息有 tool_calls
 *     但后续缺少对应的 tool 回复（SSE 断裂场景），去掉 tool_calls 只保留文本。
 * 兼容 OpenAI/DeepSeek/Qwen 等所有 OpenAI-compatible Provider
 */
export function sanitizeMessages(messages: Message[]): Message[] {
  // K3: 收集所有已有 tool 回复的 toolCallId
  const answeredToolIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      answeredToolIds.add(m.toolCallId);
    }
  }

  return messages.map((m, idx) => {
    if (m.role === 'assistant' && m.content == null) {
      m = { ...m, content: '' };
    }
    // K3: 如果 assistant 有 tool_calls 但部分/全部缺少 tool 回复 → 去掉 tool_calls
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const unanswered = m.toolCalls.filter((tc) => !answeredToolIds.has(tc.id));
      if (unanswered.length > 0) {
        // 有未回复的 tool_call → 移除所有 tool_calls，只保留文本
        log.warn(
          {
            idx,
            totalToolCalls: m.toolCalls.length,
            unansweredToolCalls: unanswered.length,
            unansweredNames: unanswered.map((tc) => tc.name),
          },
          'sanitizeMessages: removing unanswered tool_calls from assistant message',
        );
        const { toolCalls, ...rest } = m;
        return rest;
      }
    }
    return m;
  });
}

/**
 * Message → OpenAI chat/completions wire-format
 */
export function toOpenAIMessage(m: Message): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.toolCalls && m.toolCalls.length > 0) {
    out.tool_calls = m.toolCalls.map((tc: ToolCall) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.argsRaw },
    }));
  }
  if (m.toolCallId) out.tool_call_id = m.toolCallId;
  if (m.name) out.name = m.name;
  return out;
}
