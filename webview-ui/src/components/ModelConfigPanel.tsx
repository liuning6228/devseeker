/**
 * ModelConfigPanel — LLM/VLLM 双轨 3 级降级链配置面板
 *
 * 参考 Cline 简洁风格：Provider 下拉 + API Key 输入 + Model 下拉
 * 即改即写：字段 blur/change 时自动写入 VS Code settings
 */

import { useCallback, useEffect, useState } from 'react';
import type { ModelConfigPayload, ModelLevelConfigPayload, WebviewInboundMessage } from '../protocol';

// ─────────── Provider 选项 ───────────

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  qwen: 'Qwen（通义千问）',
  'qwen-code': 'Qwen Code',
  anthropic: 'Anthropic Claude',
  openrouter: 'OpenRouter',
  ollama: 'Ollama（本地）',
  'custom-openai': '自定义 OpenAI 兼容',
};

const LEVEL_LABELS: Record<number, string> = {
  1: '主力模型',
  2: '备选模型',
  3: '兜底模型',
};

// ─────────── Props ───────────

export interface ModelConfigPanelProps {
  config: ModelConfigPayload | null;
  onClose: () => void;
  /** 发送消息给 Extension Host（避免重复调用 acquireVsCodeApi） */
  postMessage: (msg: WebviewInboundMessage) => void;
}

// ─────────── LevelConfigForm ───────────

function LevelConfigForm({
  track,
  level,
  data,
  defaults,
  providerTypes,
  models,
  expanded: defaultExpanded,
  postMessage,
}: {
  track: 'llm' | 'vllm';
  level: 1 | 2 | 3;
  data: ModelLevelConfigPayload;
  defaults: ModelConfigPayload['providerDefaults'];
  providerTypes: string[];
  models: ModelConfigPayload['providerModels'];
  expanded: boolean;
  postMessage: (msg: WebviewInboundMessage) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [provider, setProvider] = useState(data.provider);
  const [model, setModel] = useState(data.model);
  const [apiKey, setApiKey] = useState(data.apiKeySet ? '••••••••' : '');
  const [baseUrl, setBaseUrl] = useState(data.baseUrl);
  const [reasoningModel, setReasoningModel] = useState(data.reasoningModel);
  const [apiKeysCount, setApiKeysCount] = useState(data.apiKeysCount);

  // 当 data prop 变化时（后端推送新配置），同步更新本地 state
  useEffect(() => {
    setProvider(data.provider);
    setModel(data.model);
    setApiKey(data.apiKeySet ? '••••••••' : '');
    setBaseUrl(data.baseUrl);
    setReasoningModel(data.reasoningModel);
    setApiKeysCount(data.apiKeysCount);
  }, [data.provider, data.model, data.apiKeySet, data.baseUrl, data.reasoningModel, data.apiKeysCount]);

  // Provider 变更时自动切换 model 默认值
  const handleProviderChange = useCallback(
    (newProvider: string) => {
      setProvider(newProvider);
      const def = defaults[newProvider];
      if (def) {
        setModel(def.model);
        setBaseUrl(def.baseUrl);
        setReasoningModel(def.reasoningModel ?? '');
      }
      // 即写
      postMessage({
        type: 'update_model_config',
        track,
        level,
        field: 'provider',
        value: newProvider,
      });
      // 延迟写 model 和 baseUrl（等 provider 生效）
      setTimeout(() => {
        if (def) {
          postMessage({ type: 'update_model_config', track, level, field: 'model', value: def.model });
          postMessage({ type: 'update_model_config', track, level, field: 'baseUrl', value: def.baseUrl });
        }
      }, 50);
    },
    [track, level, defaults],
  );

  const handleFieldBlur = useCallback(
    (field: 'apiKey' | 'model' | 'baseUrl' | 'reasoningModel', value: string) => {
      // apiKey 如果是掩码则不更新
      if (field === 'apiKey' && value === '••••••••') return;
      postMessage({ type: 'update_model_config', track, level, field, value });
    },
    [track, level],
  );

  // 获取当前 provider 的推荐 model 列表
  const defaultModels: Array<{ id: string; label: string; free?: boolean }> = [];
  const def = defaults[provider];
  if (def) {
    defaultModels.push({ id: def.model, label: def.model });
    if (def.reasoningModel && def.reasoningModel !== def.model) {
      defaultModels.push({ id: def.reasoningModel, label: def.reasoningModel });
    }
  }
  // 从 providerModels 获取当前 provider 的完整模型列表
  const allModels = models[provider] ?? [];

  return (
    <div className={`mc-level ${expanded ? 'mc-level--expanded' : ''}`}>
      <button
        type="button"
        className="mc-level__header"
        onClick={() => setExpanded((e) => !e)}
      >
        <span className={`mc-level__chevron ${expanded ? 'mc-level__chevron--open' : ''}`}>▶</span>
        <span className="mc-level__title">
          Level {level} — {LEVEL_LABELS[level]}
        </span>
        {level > 1 && !data.provider && (
          <span className="mc-level__optional">（未配置）</span>
        )}
      </button>

      {expanded && (
        <div className="mc-level__body">
          {/* API Provider */}
          <label className="mc-field">
            <span className="mc-field__label">API Provider</span>
            <select
              className="mc-field__select"
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
            >
              {providerTypes.map((pt) => (
                <option key={pt} value={pt}>
                  {PROVIDER_LABELS[pt] ?? pt}
                </option>
              ))}
            </select>
          </label>

          {/* API Key */}
          {provider !== 'ollama' && (
            <label className="mc-field">
              <span className="mc-field__label">API Key</span>
              <input
                className="mc-field__input"
                type="password"
                placeholder={data.apiKeySet ? '已配置（留空保持不变）' : 'Enter API Key...'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={(e) => handleFieldBlur('apiKey', e.target.value)}
              />
            </label>
          )}

          {/* Model */}
          <label className="mc-field">
            <span className="mc-field__label">Model</span>
            <div className="mc-field__combo">
              <input
                className="mc-field__input"
                type="text"
                list={`model-list-${track}-${level}`}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={(e) => handleFieldBlur('model', e.target.value)}
              />
              <datalist id={`model-list-${track}-${level}`}>
                {allModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.free ? `${m.label} [FREE]` : m.label}</option>
                ))}
              </datalist>
            </div>
          </label>

          {/* Base URL (可选) */}
          <label className="mc-field mc-field--optional">
            <span className="mc-field__label">Base URL</span>
            <input
              className="mc-field__input"
              type="text"
              placeholder={def?.baseUrl ? `默认: ${def.baseUrl}` : '可选...'}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={(e) => handleFieldBlur('baseUrl', e.target.value)}
            />
          </label>

          {/* Reasoning Model (仅 LLM) */}
          {track === 'llm' && (
            <label className="mc-field mc-field--optional">
              <span className="mc-field__label">Reasoning Model</span>
              <input
                className="mc-field__input"
                type="text"
                placeholder={def?.reasoningModel ? `默认: ${def.reasoningModel}` : '可选...'}
                value={reasoningModel}
                onChange={(e) => setReasoningModel(e.target.value)}
                onBlur={(e) => handleFieldBlur('reasoningModel', e.target.value)}
              />
            </label>
          )}

          {/* 备用 Key 数量显示 */}
          {apiKeysCount > 0 && (
            <div className="mc-field__hint">
              {apiKeysCount} 个备用 API Key 已配置
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────── ModelConfigPanel ───────────

export function ModelConfigPanel({ config, onClose, postMessage }: ModelConfigPanelProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<'llm' | 'vllm'>('llm');

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!config) {
    return (
      <div className="mc-panel">
        <div className="mc-panel__header">
          <span className="mc-panel__title">模型配置</span>
          <button type="button" className="mc-panel__close" onClick={onClose}>✕</button>
        </div>
        <div className="mc-panel__empty">加载中...</div>
      </div>
    );
  }

  const trackConfig = config[activeTab];

  return (
    <div className="mc-panel">
      {/* Header */}
      <div className="mc-panel__header">
        <span className="mc-panel__title">模型配置</span>
        <button type="button" className="mc-panel__close" onClick={onClose}>✕</button>
      </div>

      {/* Tabs */}
      <div className="mc-tabs">
        <button
          type="button"
          className={`mc-tabs__tab ${activeTab === 'llm' ? 'mc-tabs__tab--active' : ''}`}
          onClick={() => setActiveTab('llm')}
        >
          LLM
        </button>
        <button
          type="button"
          className={`mc-tabs__tab ${activeTab === 'vllm' ? 'mc-tabs__tab--active' : ''}`}
          onClick={() => setActiveTab('vllm')}
        >
          VLLM
        </button>
      </div>

      {/* Level Forms */}
      <div className="mc-panel__body">
        <LevelConfigForm
          key={`${activeTab}-L1`}
          track={activeTab}
          level={1}
          data={trackConfig.level1}
          defaults={config.providerDefaults}
          providerTypes={config.providerTypes}
          models={config.providerModels}
          expanded={true}
          postMessage={postMessage}
        />
        {trackConfig.level2 && (
          <LevelConfigForm
            key={`${activeTab}-L2`}
            track={activeTab}
            level={2}
            data={trackConfig.level2}
            defaults={config.providerDefaults}
            providerTypes={config.providerTypes}
            models={config.providerModels}
            expanded={false}
            postMessage={postMessage}
          />
        )}
        {trackConfig.level3 && (
          <LevelConfigForm
            key={`${activeTab}-L3`}
            track={activeTab}
            level={3}
            data={trackConfig.level3}
            defaults={config.providerDefaults}
            providerTypes={config.providerTypes}
            models={config.providerModels}
            expanded={false}
            postMessage={postMessage}
          />
        )}

        {/* Level 2/3 未配置时的占位 */}
        {!trackConfig.level2 && (
          <div className="mc-level mc-level--placeholder">
            <button
              type="button"
              className="mc-level__header"
              onClick={() => {
                postMessage({ type: 'update_model_config', track: activeTab, level: 2, field: 'provider', value: 'deepseek' });
              }}
            >
              <span className="mc-level__chevron">▶</span>
              <span className="mc-level__title">Level 2 — 备选模型</span>
              <span className="mc-level__optional">（点击添加）</span>
            </button>
          </div>
        )}
        {!trackConfig.level3 && (
          <div className="mc-level mc-level--placeholder">
            <button
              type="button"
              className="mc-level__header"
              onClick={() => {
                postMessage({ type: 'update_model_config', track: activeTab, level: 3, field: 'provider', value: 'ollama' });
              }}
            >
              <span className="mc-level__chevron">▶</span>
              <span className="mc-level__title">Level 3 — 兜底模型</span>
              <span className="mc-level__optional">（点击添加）</span>
            </button>
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="mc-panel__status">
        {config.activeProviderId && (
          <span className={`mc-status ${config.activeProviderOk ? 'mc-status--ok' : 'mc-status--err'}`}>
            ● {config.activeProviderId} {config.activeProviderOk ? 'ok' : 'offline'}
          </span>
        )}
      </div>

      {/* Footer hint */}
      <div className="mc-panel__footer">
        配置即时生效 · API Key 仅存储在本地
      </div>
    </div>
  );
}
