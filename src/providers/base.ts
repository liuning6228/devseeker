/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * IProvider 基类与抽象
 *
 * 来源：DESIGN §M1.2
 */

import type {
  Capability,
  CreateMessageOptions,
  Message,
  Pricing,
  ProbeResult,
  ProviderId,
  StreamEvent,
  ProviderError,
} from './types.js';
import { AgentError, ErrorCodes } from '../core/errors/index.js';

export interface IProvider {
  id: ProviderId;
  readonly capabilities: readonly Capability[];
  readonly contextWindow: number;
  readonly pricing: Pricing;
  /**
   * 可选：reasoning 模型 id（W15.5 Auto-Thinking-Router）。
   * 若 Provider 含 'reasoning' capability，应同时公开该字段，
   * 供路由层决策是否把 modelOverride 切到 reasoner。
   */
  readonly reasoningModel?: string;

  /** 真流式调用（DESIGN §M1.2 刚性） */
  createMessage(options: CreateMessageOptions): AsyncIterable<StreamEvent>;

  /** 连通性检测 */
  probe(): Promise<ProbeResult>;

  /** Token 计数（预算估算） */
  countTokens(messages: Message[]): Promise<number>;

  /**
   * P1-1: 动态更新 API Key（用于同级多 Key 轮换）。
   * ProviderRegistry 在 429 时调用此方法切换到下一个 Key，
   * 无需重建整个 Provider 实例。
   */
  updateApiKey(apiKey: string): void;
}

/**
 * 所有 Provider 基类。提供：
 * - countTokens 兜底实现（字符数/4 估算）
 * - AgentError → ProviderError 归一化
 * - error + done 配对保证（M1.2 刚性）
 */
export abstract class BaseProvider implements IProvider {
  abstract readonly capabilities: readonly Capability[];
  abstract readonly contextWindow: number;
  abstract readonly pricing: Pricing;

  /**
   * Provider 唯一标识。
   * 子类通常声明 `readonly id: ProviderId = 'xxx'`，
   * 但在 3 级降级链场景下，同一 ProviderType 可能有多个实例，
   * 需要通过 idOverride 覆盖为 `provider:track:L{n}` 格式。
   */
  private _idOverride?: ProviderId;

  get id(): ProviderId {
    return this._idOverride ?? this._defaultId();
  }
  set id(value: ProviderId) {
    this._idOverride = value;
  }
  /** 子类必须提供默认 id（即原来的 readonly id 赋值） */
  protected abstract _defaultId(): ProviderId;

  /**
   * P1-1: 动态更新 API Key（默认 no-op，子类覆盖）。
   * ProviderRegistry 在 429 轮换 Key 时调用。
   */
  updateApiKey(_apiKey: string): void {
    // 默认 no-op；子类覆盖以替换内部 apiKey
  }

  abstract createMessage(options: CreateMessageOptions): AsyncIterable<StreamEvent>;
  abstract probe(): Promise<ProbeResult>;

  /**
   * 默认：按字符数/4 估算 Token。
   * 子类可覆盖为 tiktoken / gpt-tokenizer 更精确实现。
   */
  async countTokens(messages: Message[]): Promise<number> {
    let total = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        total += Math.ceil(msg.content.length / 4);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') total += Math.ceil(part.text.length / 4);
          else if (part.type === 'image_url') total += 1024; // 图像粗估
        }
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          total += Math.ceil((tc.argsRaw?.length ?? 0) / 4) + 10;
        }
      }
      total += 4; // role + 分隔开销
    }
    return total;
  }

  /**
   * 将任意错误归一化为 ProviderError 用于 error 事件。
   */
  protected toProviderError(e: unknown): ProviderError {
    if (e instanceof AgentError) {
      return {
        code: e.code,
        message: e.message,
        retryable: e.retryable,
        providerId: this.id,
      };
    }
    return {
      code: ErrorCodes.INTERNAL_UNKNOWN,
      message: e instanceof Error ? e.message : String(e),
      retryable: false,
      providerId: this.id,
    };
  }
}
