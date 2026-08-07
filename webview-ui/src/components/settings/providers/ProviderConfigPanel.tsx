import React, { useCallback, useMemo, useState } from 'react';
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

  // 自定义 Provider 输入模式
  const [customProviderMode, setCustomProviderMode] = useState(() =>
    !PROVIDER_TYPES.includes(providerId as ProviderType) && providerId !== '',
  );
  const [customProviderInput, setCustomProviderInput] = useState(() =>
    !PROVIDER_TYPES.includes(providerId as ProviderType) ? providerId : '',
  );

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
    // 自定义 Provider 或未知 Provider：返回空列表，用户可手动输入模型名
    return [];
  }, [modelOptions, provider]);

  // Provider 变更处理：通过 onProviderChange 通知父组件，父级负责重置 model + baseUrl
  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newProvider = e.target.value;
      if (newProvider === '__custom__') {
        // 切换到自定义模式
        setCustomProviderMode(true);
        setCustomProviderInput('');
        return;
      }
      setCustomProviderMode(false);
      onProviderChange?.(newProvider);
    },
    [onProviderChange],
  );

  // 自定义 Provider 确认
  const handleCustomProviderConfirm = useCallback(() => {
    const trimmed = customProviderInput.trim();
    if (trimmed) {
      onProviderChange?.(trimmed);
    }
  }, [customProviderInput, onProviderChange]);

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
          {customProviderMode ? (
            // 自定义 Provider 输入模式
            <div className="flex gap-2">
              <input
                type="text"
                value={customProviderInput}
                onChange={(e) => setCustomProviderInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCustomProviderConfirm();
                  if (e.key === 'Escape') {
                    setCustomProviderMode(false);
                    setCustomProviderInput('');
                  }
                }}
                placeholder="输入 Provider ID（如 zhipu、yi 等）"
                className="flex-1 px-3 py-2 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border
                           focus:outline-none focus:ring-2 focus:ring-vscode-focus placeholder:text-vscode-fg/40"
                autoFocus
              />
              <button
                type="button"
                onClick={handleCustomProviderConfirm}
                className="px-3 py-2 text-sm rounded bg-vscode-focus-bg text-vscode-fg hover:opacity-80 cursor-pointer"
              >
                确认
              </button>
              <button
                type="button"
                onClick={() => {
                  setCustomProviderMode(false);
                  setCustomProviderInput('');
                }}
                className="px-3 py-2 text-sm rounded bg-vscode-sidebar-bg text-vscode-fg/60 hover:text-vscode-fg cursor-pointer"
              >
                取消
              </button>
            </div>
          ) : (
            <select
              value={PROVIDER_TYPES.includes(providerId as ProviderType) ? providerId : (providerId ? '__unknown__' : '')}
              onChange={handleProviderChange}
              className="w-full px-3 py-2 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border focus:outline-none focus:ring-2 focus:ring-vscode-focus"
            >
              <option value="">（未选择）</option>
              {PROVIDER_TYPES.map((pt) => (
                <option key={pt} value={pt}>
                  {PROVIDER_DISPLAY_NAMES[pt]}
                </option>
              ))}
              <option value="__custom__">✏️ 自定义 Provider…</option>
              {providerId && !PROVIDER_TYPES.includes(providerId as ProviderType) && (
                <option value="__unknown__" disabled>当前: {providerId}</option>
              )}
            </select>
          )}
          {/* 当前 Provider 不在已知列表中时显示提示 */}
          {!PROVIDER_TYPES.includes(providerId as ProviderType) && providerId && !customProviderMode && (
            <p className="text-xs text-vscode-fg/40">
              当前: <code className="text-vscode-focus">{providerId}</code>
              <button
                type="button"
                onClick={() => setCustomProviderMode(true)}
                className="ml-2 underline cursor-pointer text-vscode-focus hover:opacity-80"
              >
                修改
              </button>
            </p>
          )}
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
