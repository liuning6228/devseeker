/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * OpenAI Provider（gpt-4o / gpt-4o-mini）
 *
 * 继承 {@link OpenAICompatibleProvider}。
 *
 * 默认：
 * - baseUrl: https://api.openai.com/v1
 * - model:   gpt-4o-mini（便宜主力）
 * - 不启用 reasoningModel（o1 家族为独立协议分支，后续单独支持）
 *
 * 定价（2025Q4 公开报价，美元 / 百万 tokens）：
 * - gpt-4o-mini  输入 0.15 / 输出 0.60 / cached 0.075
 * - gpt-4o       输入 2.50 / 输出 10.0 / cached 1.25
 *
 * MVP 采用 gpt-4o-mini 价位作为默认展示（Router 侧可按实际 model 字符串再动态查表）。
 */

import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.js';
import type { Capability, Pricing, ProviderId } from './types.js';

export type OpenAIConfig = OpenAICompatibleConfig;

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

export class OpenAIProvider extends OpenAICompatibleProvider {
  readonly capabilities: readonly Capability[] = ['text', 'tool-use', 'vision', 'prompt-cache'];
  readonly contextWindow = 128_000;
  readonly pricing: Pricing = {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    cachedInputPerMillion: 0.075,
    currency: 'USD',
  };
  protected readonly defaultBaseUrl = DEFAULT_BASE_URL;
  protected readonly defaultModel = DEFAULT_MODEL;

  protected _defaultId(): ProviderId { return 'openai-gpt'; }

  constructor(cfg: OpenAIConfig) {
    super(cfg);
  }
}
