/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Qwen-VL Max Provider（阿里百炼 DashScope / OpenAI 兼容模式）
 *
 * 继承 {@link OpenAICompatibleProvider}。
 *
 * DashScope "compatible-mode" 完全对齐 OpenAI /v1/chat/completions，
 * 支持多模态 image_url content part、function calling 与 SSE 流式。
 *
 * 默认：
 * - baseUrl: https://dashscope.aliyuncs.com/compatible-mode/v1
 * - model:   qwen-vl-max-latest
 *
 * 定价（2025Q4 公开报价，CNY / 百万 tokens）：
 * - qwen-vl-max-latest  输入 20 / 输出 60
 *
 * 能力：text + tool-use + vision。注意 Qwen 系列 tool-use 稳定性弱于 GPT-4o/Claude，
 * ModelRouter 应优先把视觉任务交给它、把纯工具链编码交给 DeepSeek/Claude。
 */

import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.js';
import type { Capability, Pricing, ProviderId } from './types.js';

export type QwenVLConfig = OpenAICompatibleConfig;

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen-vl-max-latest';

export class QwenVLProvider extends OpenAICompatibleProvider {
  readonly capabilities: readonly Capability[] = ['text', 'tool-use', 'vision'];
  readonly contextWindow = 32_000; // qwen-vl-max 上下文 32K
  readonly pricing: Pricing = {
    inputPerMillion: 20,
    outputPerMillion: 60,
    currency: 'CNY',
  };
  protected readonly defaultBaseUrl = DEFAULT_BASE_URL;
  protected readonly defaultModel = DEFAULT_MODEL;

  protected _defaultId(): ProviderId { return 'qwen-vl-max'; }

  constructor(cfg: QwenVLConfig) {
    super(cfg);
  }
}
