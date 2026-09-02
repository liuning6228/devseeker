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
 * - 默认 model  = deepseek-v4-flash（V4-Flash，高并发低成本，1M 上下文）
 * - 默认 reasoningModel = deepseek-v4-pro（V4-Pro，复杂推理/编码任务）
 *
 * 注：DeepSeek 于 2026-04-24 上线 V4 系列，旧名 deepseek-chat / deepseek-reasoner
 * 已于 2026-07-24 停止服务。V4 正式支持 reasoning_effort 参数和 thinking 模式切换。
 * 旧模型名自动映射由 normalizeDeepSeekModel（model-config）统一处理。
 *
 * 三坑由基类兜底：
 * - K1 reasoning_content 双路径（stream-parser）
 * - K2 content:null → ""（sanitizeMessages）
 * - K3 reasoning_effort 在 V4 中已不再被拒绝，本类覆盖 forbiddenKeys() 放行
 */

import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.js';
import type { Capability, Pricing, ProviderId, CreateMessageOptions } from './types.js';

export type DeepSeekConfig = OpenAICompatibleConfig;

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
// V4-Flash：当前主力模型，高并发低成本，1M 上下文，384K 最大输出，支持思考/非思考模式
const DEFAULT_MODEL = 'deepseek-v4-flash';
// V4-Pro：复杂推理/编码任务推荐，同样支持思考/非思考模式切换
const DEFAULT_REASONING_MODEL = 'deepseek-v4-pro';

export class DeepSeekProvider extends OpenAICompatibleProvider {
  readonly capabilities: readonly Capability[] = ['text', 'tool-use', 'reasoning', 'prompt-cache'];
  readonly contextWindow = 1_000_000; // DeepSeek V4 支持 1M 上下文
  // 按 V4-Flash 公开定价（百万 tokens / CNY）：输入缓存命中 0.02，未命中 1，输出 2
  // 若实际走 V4-Pro（input 3 / output 6），可在 UI 模型配置里切换 model
  readonly pricing: Pricing = {
    inputPerMillion: 1,
    outputPerMillion: 2,
    cachedInputPerMillion: 0.02,
    currency: 'CNY',
  };
  protected readonly defaultBaseUrl = DEFAULT_BASE_URL;
  protected readonly defaultModel = DEFAULT_MODEL;

  protected _defaultId(): ProviderId { return 'deepseek-v4'; }

  // V4 正式支持 reasoning_effort 参数，不再需要过滤
  protected override forbiddenKeys(): Set<string> {
    return new Set(['seed_mode']);
  }

  // V4 需要显式传 thinking 参数才能启用思考模式
  protected override enrichRequestBody(
    body: Record<string, unknown>,
    model: string,
    _options: CreateMessageOptions,
  ): void {
    // reasoning 模型或显式切到 v4-pro → 启用思考模式
    if (model === this.reasoningModel || model === 'deepseek-v4-pro') {
      body.thinking = { type: 'enabled' };
    }
  }

  constructor(cfg: DeepSeekConfig) {
    super({
      ...cfg,
      reasoningModel: cfg.reasoningModel ?? DEFAULT_REASONING_MODEL,
    });
  }
}

// 向后兼容：旧代码从 ./deepseek 引入的 sanitizeMessages 仍可用
export { sanitizeMessages } from './openai-compatible.js';
