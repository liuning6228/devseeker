/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Model Configuration Types — LLM/VLLM 双轨 + 3 级降级链
 *
 * 设计决策（memory: 模型配置结构决策-LLM/VLLM双轨+3级降级链）：
 * - 模型按能力类型划分为 LLM（纯文本）和 VLLM（视觉支持）两大独立配置区
 * - 每类模型均采用 3 级降级链结构：Level 1（主力，必填）、Level 2（备选，可选）、Level 3（兜底，可选）
 * - 同一 Provider 可在不同级别重复配置不同模型
 * - 每级独立维护 API Key 和 Base URL，支持 Key 轮换与本地/远程混合部署
 */

// ─────────── Provider 类型枚举 ───────────

/** 支持的 Provider 类型（市场面常见供应商） */
export type ProviderType =
  | 'deepseek'
  | 'openai'
  | 'qwen'
  | 'qwen-code'
  | 'anthropic'
  | 'openrouter'
  | 'ollama'
  | 'custom-openai'; // 通用 OpenAI 兼容端点（如 one-api / new-api / router 等）

/** 所有 ProviderType 值的数组，用于 UI 遍历 */
export const PROVIDER_TYPES: readonly ProviderType[] = [
  'deepseek',
  'openai',
  'qwen',
  'qwen-code',
  'anthropic',
  'openrouter',
  'ollama',
  'custom-openai',
];

/** Provider 类型对应的显示名称 */
export const PROVIDER_DISPLAY_NAMES: Record<ProviderType, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  qwen: 'Qwen（通义千问）',
  'qwen-code': 'Qwen Code',
  anthropic: 'Anthropic Claude',
  openrouter: 'OpenRouter',
  ollama: 'Ollama（本地）',
  'custom-openai': '自定义 OpenAI 兼容',
};

// ─────────── Provider 可选模型列表 ───────────

/** 模型选项（用于 UI 下拉） */
export interface ModelOption {
  id: string;
  /** 显示名称（含 free 标注等） */
  label: string;
  /** 是否免费 */
  free?: boolean;
}

/** 每个 Provider 的可选模型列表（按推荐度排序） */
export const PROVIDER_MODELS: Record<ProviderType, ModelOption[]> = {
  deepseek: [
    { id: 'deepseek-chat', label: 'deepseek-chat (V3)' },
    { id: 'deepseek-reasoner', label: 'deepseek-reasoner (R1)' },
  ],
  openai: [
    { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
    { id: 'gpt-4o', label: 'gpt-4o' },
    { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
    { id: 'gpt-4.1', label: 'gpt-4.1' },
    { id: 'o4-mini', label: 'o4-mini' },
    { id: 'o3', label: 'o3' },
  ],
  qwen: [
    // ── Qwen3 开源系列 ──
    { id: 'qwen3-235b-a22b', label: 'qwen3-235b-a22b (Thinking)' },
    { id: 'qwen3-32b', label: 'qwen3-32b (Thinking)' },
    { id: 'qwen3-30b-a3b', label: 'qwen3-30b-a3b (MoE)' },
    { id: 'qwen3-14b', label: 'qwen3-14b' },
    { id: 'qwen3-8b', label: 'qwen3-8b' },
    { id: 'qwen3-4b', label: 'qwen3-4b' },
    { id: 'qwen3-1.7b', label: 'qwen3-1.7b' },
    { id: 'qwen3-0.6b', label: 'qwen3-0.6b' },
    // ── Qwen3 Coder 开源 ──
    { id: 'qwen3-coder-plus', label: 'qwen3-coder-plus (1M ctx)', free: true },
    { id: 'qwen3-coder-flash', label: 'qwen3-coder-flash (1M ctx)', free: true },
    { id: 'qwen3-coder-480b-a35b-instruct', label: 'qwen3-coder-480b (MoE 35B)' },
    // ── Qwen3.5 系列 ──
    { id: 'qwen3.5-plus', label: 'qwen3.5-plus (Multimodal)' },
    // ── Qwen2.5 Coder 系列 ──
    { id: 'qwen2.5-coder-32b-instruct', label: 'qwen2.5-coder-32b' },
    { id: 'qwen2.5-coder-14b-instruct', label: 'qwen2.5-coder-14b' },
    { id: 'qwen2.5-coder-7b-instruct', label: 'qwen2.5-coder-7b' },
    { id: 'qwen2.5-coder-3b-instruct', label: 'qwen2.5-coder-3b', free: true },
    { id: 'qwen2.5-coder-1.5b-instruct', label: 'qwen2.5-coder-1.5b', free: true },
    { id: 'qwen2.5-coder-0.5b-instruct', label: 'qwen2.5-coder-0.5b', free: true },
    // ── 闭源 API 模型 ──
    { id: 'qwen-coder-plus-latest', label: 'qwen-coder-plus-latest' },
    { id: 'qwen-coder-plus', label: 'qwen-coder-plus' },
    { id: 'qwen-plus-latest', label: 'qwen-plus-latest' },
    { id: 'qwen-plus', label: 'qwen-plus' },
    { id: 'qwen-turbo-latest', label: 'qwen-turbo-latest' },
    { id: 'qwen-turbo', label: 'qwen-turbo' },
    { id: 'qwen-max-latest', label: 'qwen-max-latest' },
    { id: 'qwen-max', label: 'qwen-max' },
    { id: 'qwen-long', label: 'qwen-long (1M ctx)' },
    // ── 推理模型 ──
    { id: 'qwq-plus-latest', label: 'qwq-plus-latest (Reasoning)', free: true },
    { id: 'qwq-plus', label: 'qwq-plus (Reasoning)', free: true },
    { id: 'qwq-32b', label: 'qwq-32b (Reasoning)' },
    // ── 视觉模型 ──
    { id: 'qwen-vl-max-latest', label: 'qwen-vl-max-latest (Vision)' },
    { id: 'qwen-vl-max', label: 'qwen-vl-max (Vision)' },
    { id: 'qwen-vl-plus-latest', label: 'qwen-vl-plus-latest (Vision)' },
    { id: 'qwen-vl-plus', label: 'qwen-vl-plus (Vision)' },
    // ── 通过 Qwen 调用的 DeepSeek ──
    { id: 'deepseek-v3', label: 'deepseek-v3 (via Qwen)' },
    { id: 'deepseek-r1', label: 'deepseek-r1 (via Qwen)' },
  ],
  'qwen-code': [
    { id: 'qwen3-coder-plus', label: 'qwen3-coder-plus (1M ctx)', free: true },
    { id: 'qwen3-coder-flash', label: 'qwen3-coder-flash (1M ctx)', free: true },
    { id: 'qwen-coder-plus-latest', label: 'qwen-coder-plus-latest' },
    { id: 'qwen-coder-plus', label: 'qwen-coder-plus' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { id: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
    { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
  ],
  openrouter: [
    // ── 免费模型（:free 后缀） — 全部 33 个 ──
    { id: 'qwen/qwen3-coder:free', label: 'Qwen3 Coder 480B', free: true },
    { id: 'qwen/qwen3-next-80b-a3b-instruct:free', label: 'Qwen3 Next 80B', free: true },
    { id: 'openai/gpt-oss-120b:free', label: 'GPT-OSS 120B', free: true },
    { id: 'openai/gpt-oss-20b:free', label: 'GPT-OSS 20B', free: true },
    { id: 'deepseek/deepseek-chat:free', label: 'DeepSeek V3', free: true },
    { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1', free: true },
    { id: 'deepseek/deepseek-r1-0528:free', label: 'DeepSeek R1 0528', free: true },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B', free: true },
    { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B', free: true },
    { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B', free: true },
    { id: 'google/gemma-3-27b-it:free', label: 'Gemma 3 27B', free: true },
    { id: 'google/gemma-3-12b-it:free', label: 'Gemma 3 12B', free: true },
    { id: 'google/gemma-3-4b-it:free', label: 'Gemma 3 4B', free: true },
    { id: 'google/lyria-3-pro-preview:free', label: 'Lyria 3 Pro (Vision 1M)', free: true },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B', free: true },
    { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', label: 'Nemotron 3 Nano Reasoning', free: true },
    { id: 'nvidia/nemotron-3-nano-30b-a3b:free', label: 'Nemotron 3 Nano 30B', free: true },
    { id: 'nvidia/nemotron-nano-12b-v2-vl:free', label: 'Nemotron Nano 12B VL', free: true },
    { id: 'nvidia/nemotron-nano-9b-v2:free', label: 'Nemotron Nano 9B', free: true },
    { id: 'minimax/minimax-m2.5:free', label: 'MiniMax M2.5', free: true },
    { id: 'z-ai/glm-4.5-air:free', label: 'GLM 4.5 Air', free: true },
    { id: 'tencent/hy3-preview:free', label: 'Tencent HY3 Preview', free: true },
    { id: 'inclusionai/ling-2.6-1t:free', label: 'Ling 2.6 1T', free: true },
    { id: 'poolside/laguna-xs.2:free', label: 'Laguna XS.2', free: true },
    { id: 'poolside/laguna-m.1:free', label: 'Laguna M.1', free: true },
    { id: 'nousresearch/hermes-3-llama-3.1-405b:free', label: 'Hermes 3 Llama 405B', free: true },
    { id: 'moonshotai/kimi-k2:free', label: 'Kimi K2', free: true },
    { id: 'baidu/qianfan-ocr-fast:free', label: 'Qianfan OCR Fast', free: true },
    { id: 'liquid/lfm-2.5-1.2b-thinking:free', label: 'LFM 2.5 1.2B Thinking', free: true },
    { id: 'liquid/lfm-2.5-1.2b-instruct:free', label: 'LFM 2.5 1.2B', free: true },
    { id: 'openrouter/free', label: 'Free Router (随机免费)', free: true },
    // ── 热门付费模型 ──
    // Anthropic
    { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
    { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
    { id: 'anthropic/claude-opus-4.6', label: 'Claude Opus 4.6' },
    { id: 'anthropic/claude-opus-4.5', label: 'Claude Opus 4.5' },
    { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
    { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku' },
    // OpenAI
    { id: 'openai/gpt-4.1', label: 'GPT-4.1' },
    { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { id: 'openai/gpt-4.1-nano', label: 'GPT-4.1 Nano' },
    { id: 'openai/gpt-4o', label: 'GPT-4o' },
    { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
    { id: 'openai/o4-mini', label: 'o4-mini' },
    { id: 'openai/o3-mini', label: 'o3-mini' },
    // Google
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'google/gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    // xAI
    { id: 'x-ai/grok-3-beta', label: 'Grok 3 Beta' },
    { id: 'x-ai/grok-3-mini-beta', label: 'Grok 3 Mini' },
    // DeepSeek
    { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3 (paid)' },
    { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1 (paid)' },
    // Meta
    { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick' },
    { id: 'meta-llama/llama-4-scout', label: 'Llama 4 Scout' },
    // Mistral
    { id: 'mistralai/devstral', label: 'Devstral (Coding)' },
    { id: 'mistralai/mistral-large-2411', label: 'Mistral Large' },
    // Qwen
    { id: 'qwen/qwen3-235b-a22b', label: 'Qwen3 235B (paid)' },
    { id: 'qwen/qwen3-coder', label: 'Qwen3 Coder (paid)' },
    // Moonshot
    { id: 'moonshotai/kimi-k2', label: 'Kimi K2 (paid)' },
  ],
  ollama: [
    { id: 'qwen3:8b', label: 'qwen3:8b' },
    { id: 'llava:13b', label: 'llava:13b (Vision)' },
    { id: 'gemma3:4b', label: 'gemma3:4b' },
    { id: 'deepseek-r1:8b', label: 'deepseek-r1:8b' },
    { id: 'llama3.2:3b', label: 'llama3.2:3b' },
  ],
  'custom-openai': [
    { id: '_placeholder_', label: '自由输入任意 Model ID（如 gpt-4o-mini / deepseek-chat 等）' },
  ],
};

// ─────────── 单级模型配置 ───────────

/** 3 级降级链中的级别 */
export type ModelLevel = 1 | 2 | 3;

/** 单级模型配置（一个 Level 的完整描述） */
export interface ModelLevelConfig {
  /** Provider 类型 */
  provider: ProviderType;
  /** 模型名称（如 deepseek-chat / qwen-plus / gpt-4o-mini） */
  model: string;
  /** API Key（Ollama 本地可为空） */
  apiKey?: string;
  /**
   * P1-1: 同级多 API Key 轮换。
   * 429/overload 时优先在同级内轮换 Key，全部 Key 耗尽后才降级到下一 Level。
   * 若提供则优先于 apiKey（轮换时 apiKey 作为第一个 key 使用）。
   */
  apiKeys?: string[];
  /** API Base URL（省略则用该 Provider 的默认 URL） */
  baseUrl?: string;
  /**
   * 可选：reasoning 模型 id。
   * 仅对具备 reasoning capability 的 Provider 有效（如 DeepSeek 的 deepseek-reasoner）。
   * 在 Auto-Thinking-Router 探测到需要 reasoning 时，本级会切换到此模型。
   */
  reasoningModel?: string;
  /**
   * 可选：覆盖 Provider 默认的上下文窗口大小（token 数）。
   * 0 或未设置 = 使用 Provider 硬编码默认值（DeepSeek 1M / OpenAI 128K / Anthropic 200K）。
   * 适用于自定义模型或不同规格的 API 端点。
   */
  contextWindow?: number;
}

// ─────────── 双轨模型配置 ───────────

/** 单轨（LLM 或 VLLM）的 3 级配置 */
export interface ModelTrackConfig {
  /** Level 1：主力模型（必填） */
  level1: ModelLevelConfig;
  /** Level 2：备选模型（可选，429/timeout 时降级） */
  level2?: ModelLevelConfig;
  /** Level 3：兜底模型（可选，L2 也失败时降级） */
  level3?: ModelLevelConfig;
}

/** 完整模型配置：LLM + VLLM 双轨 */
export interface ModelsConfig {
  /** LLM（纯文本模型）3 级降级链 */
  llm: ModelTrackConfig;
  /** VLLM（视觉模型）3 级降级链 */
  vllm: ModelTrackConfig;
}

// ─────────── Provider 默认值 ───────────

/** 每个 ProviderType 的默认 baseUrl + 默认 model + 默认 reasoningModel */
export interface ProviderDefaults {
  baseUrl: string;
  /** LLM 轨默认 model */
  model: string;
  /** VLLM 轨默认 model（若省略则回退到 model） */
  vllmModel?: string;
  reasoningModel?: string;
  /** 该 Provider 类型是否通常支持 vision */
  hasVision: boolean;
}

/** Provider 类型 → 默认配置映射 */
export const PROVIDER_DEFAULTS: Record<ProviderType, ProviderDefaults> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat', // 当前路由到 V4-Flash 非thinking；可直接填 deepseek-v4-pro / deepseek-v4-flash
    reasoningModel: 'deepseek-reasoner', // 当前路由到 V4-Flash thinking 模式
    hasVision: false,
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    vllmModel: 'gpt-4o',
    hasVision: true,
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    vllmModel: 'qwen-vl-plus',
    hasVision: true,
  },
  'qwen-code': {
    baseUrl: 'https://chat.qwen.ai/api/v1',
    model: 'qwen3-coder-plus',
    hasVision: false,
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-sonnet-20241022',
    vllmModel: 'claude-3-5-sonnet-20241022',
    hasVision: true,
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4.5',
    vllmModel: 'anthropic/claude-sonnet-4.5',
    hasVision: true,
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    hasVision: false,
  },
  'custom-openai': {
    baseUrl: '',
    model: '',
    hasVision: false,
  },
};

// ─────────── 辅助函数 ───────────

/** 获取某级配置的完整 Provider ID（格式：provider:L{level}） */
export function getLevelProviderId(provider: ProviderType, level: ModelLevel, track: 'llm' | 'vllm'): string {
  return `${provider}:${track}:L${level}`;
}

/** 获取某级配置的有效 baseUrl（用户未配则回退到 Provider 默认值） */
export function resolveBaseUrl(config: ModelLevelConfig): string {
  const custom = (config.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (custom) return custom;
  return PROVIDER_DEFAULTS[config.provider].baseUrl;
}

/** 获取某级配置的有效 model（用户未配则回退到 Provider 默认值） */
export function resolveModel(config: ModelLevelConfig, track?: 'llm' | 'vllm'): string {
  const custom = (config.model ?? '').trim();
  if (custom) return custom;
  const defaults = PROVIDER_DEFAULTS[config.provider];
  if (track === 'vllm' && defaults.vllmModel) return defaults.vllmModel;
  return defaults.model;
}

/** 获取某级配置的有效 reasoningModel */
export function resolveReasoningModel(config: ModelLevelConfig): string | undefined {
  if (config.reasoningModel?.trim()) return config.reasoningModel.trim();
  return PROVIDER_DEFAULTS[config.provider].reasoningModel;
}

/** 将 ModelTrackConfig 展平为 (level + config) 数组，便于遍历 */
export function flattenLevels(track: ModelTrackConfig): Array<{ level: ModelLevel; config: ModelLevelConfig }> {
  const result: Array<{ level: ModelLevel; config: ModelLevelConfig }> = [
    { level: 1, config: track.level1 },
  ];
  if (track.level2) result.push({ level: 2, config: track.level2 });
  if (track.level3) result.push({ level: 3, config: track.level3 });
  return result;
}

/** 检查某级配置是否有有效凭证（apiKey 非空，或 Ollama 不需要 key） */
export function hasValidCredentials(config: ModelLevelConfig): boolean {
  if (config.provider === 'ollama') return true; // 本地无需 key
  const keys = resolveApiKeys(config);
  return keys.length > 0;
}

/**
 * P1-1: 解析某级配置的所有 API Key（合并 apiKey + apiKeys）。
 * apiKey 作为第一个 key，apiKeys 追加在后面，去重去空。
 */
export function resolveApiKeys(config: ModelLevelConfig): string[] {
  const keys: string[] = [];
  const single = (config.apiKey ?? '').trim();
  if (single) keys.push(single);
  if (config.apiKeys?.length) {
    for (const k of config.apiKeys) {
      const trimmed = k.trim();
      if (trimmed && !keys.includes(trimmed)) keys.push(trimmed);
    }
  }
  return keys;
}

// ─────────── 旧配置迁移 ───────────

/** 旧版扁平配置（package.json 中的 devSeeker.deepseek.* / openai.* 等） */
export interface LegacyFlatConfig {
  deepseek?: { apiKey?: string; baseUrl?: string; model?: string };
  openai?: { apiKey?: string; baseUrl?: string; model?: string };
  qwenVl?: { apiKey?: string; baseUrl?: string; model?: string };
  anthropic?: { apiKey?: string; baseUrl?: string; model?: string };
  defaultProvider?: string;
}

/**
 * 将旧版扁平配置迁移为新的 LLM/VLLM 双轨 3 级配置。
 *
 * 迁移策略：
 * - defaultProvider 或 deepseek → LLM Level 1
 * - 其余已配 key 的 Provider → LLM Level 2/3（按优先级排列）
 * - qwenVl → VLLM Level 1
 * - openai/anthropic（有 vision 能力）→ VLLM Level 2/3
 * - ollama → Level 3（兜底）
 */
export function migrateFromLegacyFlat(legacy: LegacyFlatConfig): ModelsConfig {
  const llmLevels: ModelLevelConfig[] = [];
  const vllmLevels: ModelLevelConfig[] = [];

  // DeepSeek
  if (legacy.deepseek?.apiKey?.trim()) {
    llmLevels.push({
      provider: 'deepseek',
      model: legacy.deepseek.model || 'deepseek-chat',
      apiKey: legacy.deepseek.apiKey,
      baseUrl: legacy.deepseek.baseUrl,
      reasoningModel: 'deepseek-reasoner',
    });
  }

  // OpenAI
  if (legacy.openai?.apiKey?.trim()) {
    const llmCfg: ModelLevelConfig = {
      provider: 'openai',
      model: legacy.openai.model || 'gpt-4o-mini',
      apiKey: legacy.openai.apiKey,
      baseUrl: legacy.openai.baseUrl,
    };
    const vllmCfg: ModelLevelConfig = {
      provider: 'openai',
      model: legacy.openai.model || 'gpt-4o',
      apiKey: legacy.openai.apiKey,
      baseUrl: legacy.openai.baseUrl,
    };
    llmLevels.push(llmCfg);
    vllmLevels.push(vllmCfg);
  }

  // Qwen-VL（旧版 qwenVl → 新版 qwen provider）
  if (legacy.qwenVl?.apiKey?.trim()) {
    const cfg: ModelLevelConfig = {
      provider: 'qwen',
      model: legacy.qwenVl.model || 'qwen-vl-max-latest',
      apiKey: legacy.qwenVl.apiKey,
      baseUrl: legacy.qwenVl.baseUrl,
    };
    vllmLevels.push(cfg);
    // 纯文本也可用 qwen
    if (llmLevels.length < 3) {
      llmLevels.push({
        provider: 'qwen',
        model: 'qwen-plus',
        apiKey: legacy.qwenVl.apiKey,
        baseUrl: legacy.qwenVl.baseUrl,
      });
    }
  }

  // Anthropic
  if (legacy.anthropic?.apiKey?.trim()) {
    const cfg: ModelLevelConfig = {
      provider: 'anthropic',
      model: legacy.anthropic.model || 'claude-3-5-sonnet-20241022',
      apiKey: legacy.anthropic.apiKey,
      baseUrl: legacy.anthropic.baseUrl,
    };
    llmLevels.push(cfg);
    vllmLevels.push({ ...cfg }); // 独立副本，避免 LLM/VLLM 共享引用
  }

  // 根据 defaultProvider 调整 LLM Level 1 顺序
  if (legacy.defaultProvider) {
    const providerMap: Record<string, ProviderType> = {
      'deepseek-v4': 'deepseek',
      'openai-gpt': 'openai',
      'qwen-vl-max': 'qwen',
      'anthropic-claude': 'anthropic',
    };
    const preferred = providerMap[legacy.defaultProvider];
    if (preferred) {
      const idx = llmLevels.findIndex((l) => l.provider === preferred);
      if (idx > 0) {
        // 把 preferred 提到 Level 1
        const [item] = llmLevels.splice(idx, 1);
        llmLevels.unshift(item);
      }
    }
  }

  // 至少需要 LLM Level 1，否则用 DeepSeek 占位（引导用户填 key）
  if (llmLevels.length === 0) {
    llmLevels.push({ provider: 'deepseek', model: 'deepseek-chat' });
  }
  if (vllmLevels.length === 0) {
    // VLLM 默认用 qwen
    vllmLevels.push({ provider: 'qwen', model: 'qwen-vl-max-latest' });
  }

  // LLM: 始终填充 3 个 Level（空 Level 用默认占位，确保 UI 面板始终可展开）
  while (llmLevels.length < 3) {
    const usedProviders = new Set(llmLevels.map((l) => l.provider));
    // 优先填未使用的 provider，保证降级链多样性
    if (!usedProviders.has('ollama')) {
      llmLevels.push({ provider: 'ollama', model: 'qwen3:8b' });
    } else {
      // 兜底：用 deepseek 占位（用户后续可自行修改）
      llmLevels.push({ provider: 'deepseek', model: 'deepseek-chat' });
    }
  }

  // VLLM: 始终填充 3 个 Level
  while (vllmLevels.length < 3) {
    const usedProviders = new Set(vllmLevels.map((l) => l.provider));
    if (!usedProviders.has('ollama')) {
      vllmLevels.push({ provider: 'ollama', model: 'llava:13b' });
    } else {
      vllmLevels.push({ provider: 'qwen', model: 'qwen-vl-max-latest' });
    }
  }

  return {
    llm: {
      level1: llmLevels[0],
      level2: llmLevels[1],
      level3: llmLevels[2],
    },
    vllm: {
      level1: vllmLevels[0],
      level2: vllmLevels[1],
      level3: vllmLevels[2],
    },
  };
}
