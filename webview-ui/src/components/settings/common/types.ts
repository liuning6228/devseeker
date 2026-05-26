export interface ApiConfiguration {
  /** API Provider 类型 */
  provider: string;
  /** API Key */
  apiKey: string;
  /** API 端点 */
  baseUrl: string;
  /** 模型名 */
  model: string;
  /** reasoning 模型名（可选） */
  reasoningModel?: string;
  /** 备用 Key 列表 */
  apiKeys: string[];
}

export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  /** 默认端点 */
  defaultBaseUrl: string;
  /** 默认模型 */
  defaultModel: string;
  /** 支持 reasoning */
  supportsReasoning?: boolean;
  /** 支持视觉 */
  supportsVision?: boolean;
  /** 模型列表 */
  models: Array<{ id: string; name: string }>;
}
