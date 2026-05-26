import React, { useCallback, useMemo } from 'react';
import { cn } from '../../../lib/utils.js';
import { ApiKeyField } from '../common/ApiKeyField.js';
import { BaseUrlField } from '../common/BaseUrlField.js';
import { ModelAutocomplete } from '../common/ModelAutocomplete.js';
import {
  type ProviderType,
  PROVIDER_TYPES,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_MODELS,
  PROVIDER_DEFAULTS,
} from '../../../providers.js';

interface ProviderConfigPanelProps {
  /** 当前选中的 Provider ID */
  providerId: string;
  /** 显示名（如省略则从 providerId 自动推断） */
  displayName?: string;
  /** API Key */
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  /** API 端点 */
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  /** 模型名 */
  model: string;
  onModelChange: (value: string) => void;
  /** 可选的模型列表（若提供则优先使用，否则从 PROVIDER_MODELS 取） */
  modelOptions?: Array<{ id: string; name: string }>;
  /** 默认端点（提示用，若省略则从 PROVIDER_DEFAULTS 自动推断） */
  defaultBaseUrl?: string;
  /** 是否正在测试连接 */
  testing?: boolean;
  /** 连接测试结果 */
  testResult?: 'idle' | 'success' | 'error';
  onTestConnection?: () => void;
  /** Provider 变更回调 */
  onProviderChange?: (providerId: string) => void;
  /** 是否隐藏 Provider 下拉（视觉模型 tab 复用时可选择锁定 provider） */
  hideProviderSelect?: boolean;
  className?: string;
  /** 当前使用的轨：'llm' | 'vllm'，影响默认 model 选择 */
  track?: 'llm' | 'vllm';
}

/**
 * ProviderConfigPanel — 通用 Provider 配置面板
 *
 * 支持 Provider 下拉选择 + 模型选择 + API Key + Base URL。
 */
export function ProviderConfigPanel({
  providerId,
  displayName,
  apiKey,
  onApiKeyChange,
  baseUrl,
  onBaseUrlChange,
  model,
  onModelChange,
  modelOptions,
  defaultBaseUrl,
  testing,
  testResult,
  onTestConnection,
  onProviderChange,
  hideProviderSelect,
  className,
  track,
}: ProviderConfigPanelProps) {
  const provider = providerId as ProviderType;

  // 从 PROVIDER_DEFAULTS 推断默认 baseUrl
  const inferredDefaultUrl = useMemo(() => {
    if (defaultBaseUrl !== undefined) return defaultBaseUrl;
    return PROVIDER_DEFAULTS[provider]?.baseUrl ?? '';
  }, [defaultBaseUrl, provider]);

  // 当前 Provider 的可选模型列表
  const availableModels = useMemo((): Array<{ id: string; name: string }> => {
    if (modelOptions && modelOptions.length > 0) return modelOptions;
    const models = PROVIDER_MODELS[provider];
    if (models) return models.map((m) => ({ id: m.id, name: m.label }));
    return [];
  }, [modelOptions, provider]);

  // Provider 变更处理：自动切默认 model 和 baseUrl
  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newProvider = e.target.value;
      onProviderChange?.(newProvider);

      // 自动设置默认 model
      const defaults = PROVIDER_DEFAULTS[newProvider as ProviderType];
      if (defaults) {
        const defaultModel = track === 'vllm' && defaults.vllmModel
          ? defaults.vllmModel
          : defaults.model;
        if (defaultModel) {
          onModelChange(defaultModel);
        }
        // 自动设置 baseUrl
        const newModels = PROVIDER_MODELS[newProvider as ProviderType] || [];
        if (newModels.length > 0) {
          const firstModel = newModels[0];
          if (firstModel && firstModel.id !== '_placeholder_') {
            onModelChange(firstModel.id);
          }
        }
      }
    },
    [onProviderChange, onModelChange, track],
  );

  return (
    <div className={cn('space-y-3', className)}>
      {/* 标题行 + 测试连接按钮 */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-vscode-fg">
          {displayName || PROVIDER_DISPLAY_NAMES[provider] || providerId}
        </h3>
        {onTestConnection && (
          <button
            onClick={onTestConnection}
            disabled={testing || !apiKey}
            className={cn(
              'px-2.5 py-1 text-xs rounded cursor-pointer',
              testResult === 'success' ? 'text-green-600 bg-green-500/10' :
              testResult === 'error' ? 'text-red-500 bg-red-500/10' :
              'bg-vscode-sidebar-bg text-vscode-fg/60 hover:text-vscode-fg',
            )}
          >
            {testing ? '测试中...' :
             testResult === 'success' ? '✓ 可用' :
             testResult === 'error' ? '✗ 错误' :
             '测试连接'}
          </button>
        )}
      </div>

      {/* Provider 下拉选择 */}
      {!hideProviderSelect && (
        <div className="space-y-1">
          <label className="text-xs text-vscode-fg/60">Provider</label>
          <select
            value={providerId}
            onChange={handleProviderChange}
            className="w-full px-3 py-2 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border focus:outline-none focus:ring-2 focus:ring-vscode-focus"
          >
            {PROVIDER_TYPES.map((pt) => (
              <option key={pt} value={pt}>
                {PROVIDER_DISPLAY_NAMES[pt]}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* API Key */}
      <ApiKeyField value={apiKey} onChange={onApiKeyChange} />

      {/* Base URL */}
      <BaseUrlField
        value={baseUrl}
        onChange={onBaseUrlChange}
        placeholder={inferredDefaultUrl}
      />

      {/* 模型选择 */}
      <ModelAutocomplete
        value={model}
        onChange={onModelChange}
        options={availableModels}
      />
    </div>
  );
}
