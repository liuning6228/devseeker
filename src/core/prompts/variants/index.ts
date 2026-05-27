/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Prompt Variants（M3.14.6 · V2 轻量级模型适配）
 *
 * 借鉴 Cline 的 PromptRegistry + Variant 但做减法：
 * 不搞 8 种 variant，先做 3 种。
 *
 * variant 差异仅限于覆盖 L0 中的特定模块，或向 L1/L2 追加
 * 模型专属的说明文本。不改变 L0/L1/L2/L3 四层架构。
 */

export type VariantId = 'generic' | 'deepseek' | 'qwen';

export interface VariantProfile {
  id: VariantId;
  /** model id 前缀匹配模式（如 "deepseek" 匹配 "deepseek-chat"、"deepseek-reasoner"） */
  modelPrefix: string;
  /** 该 variant 的友好名称 */
  label: string;
  /** L0 追加的专属段落（在 memory-policy 之后、web-research 之前插入） */
  l0Suffix?: string;
  /** L3 environment 块追加的模型专属说明 */
  envSuffix?: string;
}

const VARIANTS: VariantProfile[] = [
  {
    id: 'generic',
    modelPrefix: '',
    label: '通用',
  },
  {
    id: 'deepseek',
    modelPrefix: 'deepseek',
    label: 'DeepSeek V4 优化',
    l0Suffix: [
      '# Model-specific Notes (DeepSeek)',
      '',
      '- You have a 1M token context window — use it effectively.',
      '- Your reasoning output (`reasoning_content`) is your internal chain-of-thought.',
      '- You may call up to 8 tools in one response when they are independent.',
      '- For long files, prefer reading by line range rather than the entire file.',
      '- This model optimizes for Chinese-mixed queries — default to Chinese when unsure.',
    ].join('\n'),
    envSuffix: [
      'Context window: 1M tokens',
      'Model type: DeepSeek V4 (with reasoning capability)',
    ].join('\n'),
  },
  {
    id: 'qwen',
    modelPrefix: 'qwen',
    label: 'Qwen 适配',
    l0Suffix: [
      '# Model-specific Notes (Qwen)',
      '',
      '- This model supports vision (image understanding).',
      '- When calling tools, ensure function call parameters follow OpenAI-compatible format.',
      '- Default to Chinese for all responses.',
    ].join('\n'),
    envSuffix: [
      'Model type: Qwen (with vision capability)',
    ].join('\n'),
  },
];

/**
 * 根据模型 id 选择 variant。
 * 按 modelPrefix 最长匹配取优先级：
 * "deepseek-reasoner" → deepseek variant
 * "qwen-plus" → qwen variant
 * "claude-sonnet" → generic
 */
export function selectVariant(modelId: string): VariantProfile {
  // 按前缀长度降序匹配（确保 "deepseek-reasoner" 命中 deepseek 而非 generic）
  const sorted = [...VARIANTS]
    .filter((v) => v.modelPrefix.length > 0)
    .sort((a, b) => b.modelPrefix.length - a.modelPrefix.length);

  for (const v of sorted) {
    if (modelId.startsWith(v.modelPrefix)) return v;
  }
  // fallback: generic
  return VARIANTS[0];
}

/**
 * 获取 variant 专属的 L0 后缀段（在 memory-policy 之后、web-research 之前插入）。
 * generic variant 返回空串。
 */
export function getVariantL0Suffix(modelId: string): string {
  const v = selectVariant(modelId);
  return v.l0Suffix ?? '';
}

/**
 * 获取 variant 专属的环境信息后缀。
 * 追加到 <environment> 块末尾。
 */
export function getVariantEnvSuffix(modelId: string): string {
  const v = selectVariant(modelId);
  return v.envSuffix ?? '';
}
