/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Provider 层共享类型
 *
 * 来源：DESIGN §M1.2 + §M1.6（StreamEvent v2）
 * 契约冻结 — 修改需走 ADR。
 */

// ─────────── 消息 ───────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 多模态 content 片段（对齐 OpenAI Vision）。
 * 纯文本消息可直接用 string；混合内容用 ContentPart[]。
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ToolCall {
  id: string;
  name: string;
  /** 原始参数字符串（LLM 输出的 JSON 字符串，尚未 parse） */
  argsRaw: string;
  /** 已 parse 的参数对象（由 TaskLoop 在解析后回填） */
  args?: Record<string, unknown>;
}

export interface Message {
  role: MessageRole;
  content: string | ContentPart[] | null; // null 仅限 DeepSeek K2 坑兼容，Provider 内部会改写为 ""
  /** assistant 消息中的工具调用 */
  toolCalls?: ToolCall[];
  /** tool role 专用：对应哪个 toolCallId */
  toolCallId?: string;
  /** 仅 DeepSeek-R：思维链（M10.5 内部使用，不发回模型） */
  reasoningContent?: string;
  name?: string;
  /** §8.14 · 标记该消息是上下文压缩后的语义摘要 */
  _compacted?: boolean;
}

// ─────────── Provider 元信息 ───────────

export type ProviderId = 'deepseek-v4' | 'qwen-vl-max' | string;

export type Capability = 'text' | 'tool-use' | 'vision' | 'reasoning' | 'prompt-cache';

export interface Pricing {
  /** 输入 Token 单价（元 / 1M tokens，人民币） */
  inputPerMillion: number;
  /** 输出 Token 单价 */
  outputPerMillion: number;
  /** 缓存命中价（如有） */
  cachedInputPerMillion?: number;
  currency: 'CNY' | 'USD';
}

// ─────────── 请求选项 ───────────

export interface CreateMessageOptions {
  messages: Message[];
  /** 可用工具清单（OpenAI tool schema 格式） */
  tools?: ToolSchema[];
  /** 由上层决定是否强制调用 */
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  /** 最大输出 tokens */
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** 可中断信号（TaskLoop Stop 按钮传入） */
  signal?: AbortSignal;
  /** 本次请求额外的模型覆盖（Debug 模式可传 deepseek-reasoner） */
  modelOverride?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

// ─────────── StreamEvent v2（DESIGN §M1.6） ───────────

/**
 * 增量流式事件。
 *
 * 契约（DESIGN §M1.2 刚性条款）：
 * - Provider 必须完整实现以下全部类型
 * - createMessage 必须真流式（非 collect-then-emit）
 * - error 事件后必须发 done 事件
 * - Provider 内部错误不得 throw，必须转为 error 事件
 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_args_delta'; id: string; partial: string }
  | { type: 'tool_end'; id: string }
  | {
      type: 'usage';
      promptTokens: number;
      completionTokens: number;
      cachedTokens?: number;
    }
  | { type: 'error'; error: ProviderError }
  | { type: 'done'; reason: DoneReason };

export type DoneReason = 'stop' | 'length' | 'tool_use' | 'error' | 'aborted';

/**
 * Provider 层错误的序列化形式（走 error 事件）。
 * 对应 SPEC/error-model.md 的 AgentError 但压扁为 JSON 可序列化。
 */
export interface ProviderError {
  code: string; // ErrorCode
  message: string;
  retryable: boolean;
  providerId?: ProviderId;
}

// ─────────── 探活 ───────────

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  model?: string;
  error?: ProviderError;
}
