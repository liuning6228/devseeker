/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * DeepSeek V4 Provider
 *
 * 来源：DESIGN §M1.3
 * 规范：SPEC/error-model.md（错误归一化）
 *
 * 本类继承 {@link OpenAICompatibleProvider}，只定制：
 * - id / capabilities / contextWindow / pricing
 * - 默认 baseUrl = https://api.deepseek.com/v1
 * - 默认 model  = deepseek-chat，reasoningModel = deepseek-reasoner
 *
 * 三坑由基类兜底：
 * - K1 reasoning_content 双路径（stream-parser）
 * - K2 content:null → ""（sanitizeMessages）
 * - K3 reasoning_effort 参数过滤（forbiddenKeys）
 */

import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.js';
import type { Capability, Pricing, ProviderId } from './types.js';

export type DeepSeekConfig = OpenAICompatibleConfig;

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat'; // 当前路由到 deepseek-v4-flash（非 thinking），2026-07 后自动切 V4
const DEFAULT_REASONING_MODEL = 'deepseek-reasoner'; // 当前路由到 deepseek-v4-flash（thinking 模式）

export class DeepSeekProvider extends OpenAICompatibleProvider {
  readonly capabilities: readonly Capability[] = ['text', 'tool-use', 'reasoning', 'prompt-cache'];
  readonly contextWindow = 1_000_000; // DeepSeek V4 支持 1M 上下文
  readonly pricing: Pricing = {
    inputPerMillion: 2,
    outputPerMillion: 8,
    cachedInputPerMillion: 0.5,
    currency: 'CNY',
  };
  protected readonly defaultBaseUrl = DEFAULT_BASE_URL;
  protected readonly defaultModel = DEFAULT_MODEL;

  protected _defaultId(): ProviderId { return 'deepseek-v4'; }

  constructor(cfg: DeepSeekConfig) {
    super({
      ...cfg,
      reasoningModel: cfg.reasoningModel ?? DEFAULT_REASONING_MODEL,
    });
  }
}

// 向后兼容：旧代码从 ./deepseek 引入的 sanitizeMessages 仍可用
export { sanitizeMessages } from './openai-compatible.js';
