/**
 * Provider 元数据常量（Webview UI 侧同构版本）
 *
 * 与 src/providers/model-config.ts 保持同步，仅包含 UI 展示所需信息。
 */

/** 支持的 Provider 类型 */
export type ProviderType =
  | 'deepseek'
  | 'openai'
  | 'qwen'
  | 'qwen-code'
  | 'anthropic'
  | 'openrouter'
  | 'ollama'
  | 'custom-openai';

/** 所有 Provider 列表（UI 下拉用） */
export const PROVIDER_TYPES: readonly ProviderType[] = [
  'deepseek',
  'openai',
  'qwen',
  'qwen-code',
  'anthropic',
  'openrouter',
  'ollama',
  'custom-openai',
] as const;

/** Provider 类型 → 显示名称 */
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

/** 模型选项 */
export interface ModelOption {
  id: string;
  label: string;
  free?: boolean;
}

/** 每个 Provider 的可选模型列表 */
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
    { id: 'qwen3-235b-a22b', label: 'qwen3-235b-a22b (Thinking)' },
    { id: 'qwen3-32b', label: 'qwen3-32b (Thinking)' },
    { id: 'qwen-plus-latest', label: 'qwen-plus-latest' },
    { id: 'qwen-plus', label: 'qwen-plus' },
    { id: 'qwen-turbo-latest', label: 'qwen-turbo-latest' },
    { id: 'qwen-turbo', label: 'qwen-turbo' },
    { id: 'qwen-max-latest', label: 'qwen-max-latest' },
    { id: 'qwen-max', label: 'qwen-max' },
    { id: 'qwen3-coder-plus', label: 'qwen3-coder-plus (1M ctx)', free: true },
    { id: 'qwen3-coder-flash', label: 'qwen3-coder-flash (1M ctx)', free: true },
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
    { id: 'deepseek/deepseek-chat:free', label: 'DeepSeek V3 (Free)', free: true },
    { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 (Free)', free: true },
    { id: 'qwen/qwen3-coder:free', label: 'Qwen3 Coder (Free)', free: true },
    { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
    { id: 'openai/gpt-4o', label: 'GPT-4o' },
    { id: 'openai/o4-mini', label: 'o4-mini' },
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'openrouter/free', label: 'Free Router (随机免费)', free: true },
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

/** Provider 默认值（仅 baseUrl 和默认 model，UI 显示用） */
export interface ProviderDefaults {
  baseUrl: string;
  model: string;
  vllmModel?: string;
}

export const PROVIDER_DEFAULTS: Record<ProviderType, ProviderDefaults> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    vllmModel: 'gpt-4o',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    vllmModel: 'qwen-vl-plus',
  },
  'qwen-code': {
    baseUrl: 'https://chat.qwen.ai/api/v1',
    model: 'qwen3-coder-plus',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-sonnet-20241022',
    vllmModel: 'claude-3-5-sonnet-20241022',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4.5',
    vllmModel: 'anthropic/claude-sonnet-4.5',
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
  },
  'custom-openai': {
    baseUrl: '',
    model: '',
  },
};
