import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { ViewHeader } from '../common/ViewHeader.js';
import { Separator } from '../ui/separator.js';
import { ProviderConfigPanel } from './providers/ProviderConfigPanel.js';
import { AutoApproveBar } from './AutoApproveBar.js';
import { Tab } from '../common/Tab.js';
import { PROVIDER_DEFAULTS } from '../../providers.js';
import { postToHost } from '../../vscode-api.js';
import type { ModelConfigPayload, ModelLevelConfigPayload, SearchConfigPayload, EmbedConfigPayload } from '../../protocol.js';

type SettingsViewProps = {
  /** 从 extension host 推送的当前模型配置 */
  config?: ModelConfigPayload | null;
  /** 从 extension host 推送的联网搜索配置 */
  searchConfig?: SearchConfigPayload | null;
  /** 从 extension host 推送的索引（Embedding）配置 */
  embedConfig?: EmbedConfigPayload | null;
  onBack?: () => void;
  className?: string;
};

const SETTINGS_TABS = [
  { id: 'llm', label: 'LLM' },
  { id: 'vllm', label: '视觉模型' },
  { id: 'index', label: '索引配置' },
  { id: 'general', label: '通用' },
  { id: 'approval', label: '审批' },
];

// ─── Level 级别标签 ───
const LEVEL_META = [
  { level: 1 as const, title: '主力模型', desc: '日常编码使用，必填', required: true },
  { level: 2 as const, title: '备选模型', desc: '主模型不可用时降级', required: false },
  { level: 3 as const, title: '兜底模型', desc: '备选也不可用时保底，推荐 Ollama 本地模型', required: false },
];

// ─── VLLM Level 级别标签（均为可选） ───
const VLLM_LEVEL_META = [
  { level: 1 as const, title: '主力视觉模型', desc: '截图粘贴时优先使用', required: false },
  { level: 2 as const, title: '备选视觉模型', desc: '主视觉模型不可用时降级', required: false },
  { level: 3 as const, title: '兜底视觉模型', desc: '备选也不可用时保底', required: false },
];

// ─── 本地编辑保护窗口：该窗口内宿主回推的同名字段不覆盖本地输入 ───
const ECHO_GUARD_MS = 2000;

/** 单级配置的本地编辑态。apiKey 只存用户新输入的明文，apiKeySet 表示宿主已保存 */
type LevelState = {
  provider: string;
  model: string;
  apiKey: string;
  apiKeySet: boolean;
  baseUrl: string;
  /** 上下文窗口（token 数）显式配置值；空字符串 = 自动推断 */
  contextWindow: string;
  /** 当前生效的上下文窗口（自动推断结果），用于占位提示 */
  contextWindowEffective: number;
};

const EMPTY_LEVEL: LevelState = { provider: '', model: '', apiKey: '', apiKeySet: false, baseUrl: '', contextWindow: '', contextWindowEffective: 0 };

// ─── 索引配置本地编辑态（数字字段字符串化；空串 = 未显式配置，使用引擎默认） ───
type EmbedState = {
  provider: string;
  baseUrl: string;
  model: string;
  dimension: string;
  batchSize: string;
  timeoutMs: string;
};

const INITIAL_EMBED: EmbedState = { provider: 'local-bert', baseUrl: '', model: '', dimension: '', batchSize: '', timeoutMs: '' };

export function SettingsView({ config, searchConfig, embedConfig, onBack, className }: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState('llm');
  // Step 21: 配置搜索
  const [searchQuery, setSearchQuery] = useState('');

  // LLM 三级配置（初始为空，等 extension host 推送真实配置后再填充，避免闪现默认值）
  const [llmLevelState, setLlmLevelState] = useState<Record<number, LevelState>>({
    1: { ...EMPTY_LEVEL },
    2: { ...EMPTY_LEVEL },
    3: { ...EMPTY_LEVEL },
  });
  const [llmLevelExpanded, setLlmLevelExpanded] = useState<Record<number, boolean>>({ 1: true });

  // VLLM 三级配置（均为可选；同样初始为空，以宿主配置为准）
  const [vllmLevelState, setVllmLevelState] = useState<Record<number, LevelState>>({
    1: { ...EMPTY_LEVEL },
    2: { ...EMPTY_LEVEL },
    3: { ...EMPTY_LEVEL },
  });
  const [vllmLevelExpanded, setVllmLevelExpanded] = useState<Record<number, boolean>>({ 1: true });

  // ─── 本地编辑标记：`${track}.${level}.${field}` → 最后编辑时间戳 ───
  const editedAtRef = useRef<Map<string, number>>(new Map());
  const markEdited = useCallback((track: 'llm' | 'vllm', level: 1 | 2 | 3, field: string) => {
    editedAtRef.current.set(`${track}.${level}.${field}`, Date.now());
  }, []);
  const isRecentlyEdited = useCallback((track: 'llm' | 'vllm', level: 1 | 2 | 3, field: string) => {
    const k = `${track}.${level}.${field}`;
    const at = editedAtRef.current.get(k);
    if (at === undefined) return false;
    if (Date.now() - at > ECHO_GUARD_MS) {
      editedAtRef.current.delete(k);
      return false;
    }
    return true;
  }, []);

  // ─── 动态模型列表（从 Provider API 获取） ───
  const [llmModelOptions, setLlmModelOptions] = useState<Record<number, { provider: string; models: Array<{ id: string; name: string }> }>>({});
  const [vllmModelOptions, setVllmModelOptions] = useState<Record<number, { provider: string; models: Array<{ id: string; name: string }> }>>({});

  // 监听 extension host 推送的动态模型列表
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const msg = ev.data;
      if (msg?.type === 'provider_models_fetched') {
        const { track, level, models, provider: fetchedProvider } = msg;
        const setter = track === 'llm' ? setLlmModelOptions : setVllmModelOptions;
        // 存储时带上所属 provider，方便 ProviderConfigPanel 校验来源是否匹配
        setter((prev) => ({ ...prev, [level]: { provider: fetchedProvider, models } }));
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // ─── 从 extension host 推送的 config 同步到本地 state ───
  // 宿主每次写配置都会回推一次 model_config（写入后立即推 + onDidChangeConfiguration 防抖再推）。
  // 若无条件用回推值重置本地 state，会把用户刚输入/刚清空的字段覆盖回旧值，
  // 表现为「API Key 设置后消失」「删完又出现删除的内容」。
  // 因此对最近编辑过的字段（ECHO_GUARD_MS 内）保留本地值，其余以宿主为准。
  useEffect(() => {
    if (!config) return;
    const merge = (
      track: 'llm' | 'vllm',
      level: 1 | 2 | 3,
      prev: LevelState | undefined,
      payload?: ModelLevelConfigPayload,
    ): LevelState => {
      const incoming: LevelState = payload
        ? {
            provider: payload.provider || '',
            model: payload.model || '',
            // 明文永不回传：输入框恢复为空，由 apiKeySet 驱动「已保存」提示。
            // 用户仍在输入框内时 DebouncedTextField 的 editingRef 会拦住这次清空。
            apiKey: '',
            apiKeySet: payload.apiKeySet,
            baseUrl: payload.baseUrl || '',
            contextWindow: payload.contextWindow || '',
            contextWindowEffective: payload.contextWindowEffective ?? 0,
          }
        : { ...EMPTY_LEVEL };
      const next = { ...incoming };
      for (const f of ['provider', 'model', 'apiKey', 'baseUrl', 'contextWindow'] as const) {
        if (isRecentlyEdited(track, level, f)) next[f] = prev?.[f] ?? '';
      }
      return next;
    };
    setLlmLevelState((prev) => ({
      1: merge('llm', 1, prev[1], config.llm.level1),
      2: merge('llm', 2, prev[2], config.llm.level2),
      3: merge('llm', 3, prev[3], config.llm.level3),
    }));
    setVllmLevelState((prev) => ({
      1: merge('vllm', 1, prev[1], config.vllm.level1),
      2: merge('vllm', 2, prev[2], config.vllm.level2),
      3: merge('vllm', 3, prev[3], config.vllm.level3),
    }));
  }, [config, isRecentlyEdited]);

  // 联网搜索
  const [tavilyKeys, setTavilyKeys] = useState('');
  const [bochaKeys, setBochaKeys] = useState('');
  const [searchProvider, setSearchProvider] = useState('auto');

  // ─── 从 extension host 推送的搜索配置同步到本地 state ───
  useEffect(() => {
    if (!searchConfig) return;
    setTavilyKeys(searchConfig.tavilyKeys.join('\n'));
    setBochaKeys(searchConfig.bochaKeys.join('\n'));
    setSearchProvider(searchConfig.defaultProvider || 'auto');
  }, [searchConfig]);

  // 搜索配置变更时即时持久化（防抖 500ms）
  const searchConfigTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistSearchField = useCallback(
    (field: 'tavilyKeys' | 'bochaKeys' | 'defaultProvider', value: string | string[]) => {
      if (searchConfigTimer.current) clearTimeout(searchConfigTimer.current);
      searchConfigTimer.current = setTimeout(() => {
        postToHost({ type: 'update_search_config', field, value });
      }, 500);
    },
    [],
  );

  // ─── 索引配置：本地态 + 宿主回推同步（ECHO_GUARD 防覆盖）+ 按字段防抖持久化 ───
  const [embedState, setEmbedState] = useState<EmbedState>(INITIAL_EMBED);
  const embedEditedAtRef = useRef<Map<string, number>>(new Map());
  const markEmbedEdited = useCallback((field: string) => {
    embedEditedAtRef.current.set(field, Date.now());
  }, []);
  const embedRecentlyEdited = useCallback((field: string) => {
    const at = embedEditedAtRef.current.get(field);
    if (at === undefined) return false;
    if (Date.now() - at > ECHO_GUARD_MS) {
      embedEditedAtRef.current.delete(field);
      return false;
    }
    return true;
  }, []);
  const embedFieldTimers = useRef<Record<string, ReturnType<typeof setTimeout> | null>>({});
  // 本地态字段 → 协议字段名映射（state 短名 vs 配置节键名）
  const EMBED_FIELD_TO_CONFIG = useRef<
    Record<keyof EmbedState, 'embedProvider' | 'embedBaseUrl' | 'embedModel' | 'embedDimension' | 'embedBatchSize' | 'embedTimeoutMs'>
  >({
    provider: 'embedProvider',
    baseUrl: 'embedBaseUrl',
    model: 'embedModel',
    dimension: 'embedDimension',
    batchSize: 'embedBatchSize',
    timeoutMs: 'embedTimeoutMs',
  }).current;
  const persistEmbedField = useCallback((field: 'embedProvider' | 'embedBaseUrl' | 'embedModel' | 'embedDimension' | 'embedBatchSize' | 'embedTimeoutMs', value: string) => {
    if (embedFieldTimers.current[field]) clearTimeout(embedFieldTimers.current[field]);
    embedFieldTimers.current[field] = setTimeout(() => {
      postToHost({ type: 'update_embed_config', field, value });
    }, 500);
  }, []);
  const updateEmbedField = useCallback((field: keyof EmbedState, value: string) => {
    markEmbedEdited(field);
    setEmbedState((prev) => ({ ...prev, [field]: value }));
    if (field === 'provider') {
      // select 即时提交（触发宿主侧切换重索引）
      postToHost({ type: 'update_embed_config', field: 'embedProvider', value });
    } else {
      persistEmbedField(EMBED_FIELD_TO_CONFIG[field], value);
    }
  }, [markEmbedEdited, persistEmbedField, EMBED_FIELD_TO_CONFIG]);

  useEffect(() => {
    if (!embedConfig) return;
    setEmbedState((prev) => {
      const next: EmbedState = {
        provider: embedConfig.embedProvider || 'local-bert',
        baseUrl: embedConfig.embedBaseUrl ?? '',
        model: embedConfig.embedModel ?? '',
        dimension: embedConfig.embedDimension ? String(embedConfig.embedDimension) : '',
        batchSize: embedConfig.embedBatchSize ? String(embedConfig.embedBatchSize) : '',
        timeoutMs: embedConfig.embedTimeoutMs ? String(embedConfig.embedTimeoutMs) : '',
      };
      for (const f of ['provider', 'baseUrl', 'model', 'dimension', 'batchSize', 'timeoutMs'] as const) {
        if (embedRecentlyEdited(f)) next[f] = prev[f];
      }
      return next;
    });
  }, [embedConfig, embedRecentlyEdited]);

  // ─── 连接测试（宿主真实探测，按 track+level 粒度） ───
  type TestState = { status: 'idle' | 'testing' | 'success' | 'error'; error?: string };
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});
  const testKey = (track: 'llm' | 'vllm', level: 1 | 2 | 3) => `${track}.${level}`;

  const handleTest = useCallback((track: 'llm' | 'vllm', level: 1 | 2 | 3) => {
    setTestStates((prev) => ({ ...prev, [`${track}.${level}`]: { status: 'testing' } }));
    postToHost({ type: 'test_provider', track, level });
  }, []);

  /** 探测中时按钮已由 testing 控制文案，此处回退 idle */
  const testResultOf = (track: 'llm' | 'vllm', level: 1 | 2 | 3): 'idle' | 'success' | 'error' => {
    const s = testStates[testKey(track, level)]?.status;
    return s === 'success' || s === 'error' ? s : 'idle';
  };

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const msg = ev.data;
      if (msg?.type !== 'provider_test_result') return;
      setTestStates((prev) => ({
        ...prev,
        [`${msg.track}.${msg.level}`]: {
          status: msg.ok ? 'success' : 'error',
          error: msg.error,
        },
      }));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // 通用更新单个字段（本地 + 持久化到 extension host）
  const updateField = useCallback(
    (setFn: React.Dispatch<React.SetStateAction<Record<number, LevelState>>>, track: 'llm' | 'vllm', level: 1 | 2 | 3, field: 'provider' | 'apiKey' | 'model' | 'baseUrl' | 'reasoningModel' | 'contextWindow', value: string) => {
      markEdited(track, level, field);

      if (field === 'apiKey') {
        // 输入框为空只意味着「未输入新值」，不代表要清空已保存的 Key（清空走「清除」按钮），
        // 否则失焦/防抖触发的空值提交会把已存的 Key 意外删掉
        const next = value.trim();
        if (!next) return;
        setFn((prev) => ({ ...prev, [level]: { ...prev[level], apiKey: next } }));
        postToHost({ type: 'update_model_config', track, level, field, value: next });
        return;
      }

      setFn((prev) => ({
        ...prev,
        [level]: { ...prev[level], [field]: value },
      }));
      postToHost({ type: 'update_model_config', track, level, field, value });
    },
    [markEdited],
  );

  /** 清除已保存的 API Key（含备用 Key 池） */
  const clearApiKey = useCallback(
    (setFn: React.Dispatch<React.SetStateAction<Record<number, LevelState>>>, track: 'llm' | 'vllm', level: 1 | 2 | 3) => {
      markEdited(track, level, 'apiKey');
      setFn((prev) => ({ ...prev, [level]: { ...prev[level], apiKey: '', apiKeySet: false } }));
      postToHost({ type: 'update_model_config', track, level, field: 'apiKey', value: '' });
      postToHost({ type: 'update_model_config', track, level, field: 'apiKeys', value: [] });
    },
    [markEdited],
  );

  // 更新 LLM 某级 provider（同时重置 model 为新 Provider 默认值 + baseUrl，并持久化）
  const updateLlmProvider = useCallback((level: 1 | 2 | 3, provider: string) => {
    markEdited('llm', level, 'provider');
    markEdited('llm', level, 'model');
    markEdited('llm', level, 'baseUrl');
    // Provider 为空时清空本地展示；宿主收到 provider='' 后会同步删除
    // model / baseUrl / reasoningModel / apiKey / contextWindow，无需再逐个下发（避免多次写入相互竞争）
    if (!provider) {
      setLlmLevelState((prev) => ({
        ...prev,
        [level]: { ...EMPTY_LEVEL },
      }));
      postToHost({ type: 'update_model_config', track: 'llm', level, field: 'provider', value: '' });
      return;
    }
    const def = PROVIDER_DEFAULTS[provider as keyof typeof PROVIDER_DEFAULTS];
    const defaultModel = def?.model ?? '';
    const defaultBaseUrl = def?.baseUrl ?? '';
    setLlmLevelState((prev) => {
      // Provider 未变 → 不重置 model / baseUrl，与宿主的幂等处理保持一致
      if (prev[level]?.provider === provider) return prev;
      return {
        ...prev,
        [level]: { ...prev[level], provider, model: defaultModel, baseUrl: defaultBaseUrl },
      };
    });
    // 持久化：provider 变更会自动联动 model + baseUrl
    postToHost({ type: 'update_model_config', track: 'llm', level, field: 'provider', value: provider });
  }, [markEdited]);

  // 更新 VLLM 某级 provider
  const updateVllmProvider = useCallback((level: 1 | 2 | 3, provider: string) => {
    markEdited('vllm', level, 'provider');
    markEdited('vllm', level, 'model');
    markEdited('vllm', level, 'baseUrl');
    // Provider 为空时清空本地展示；其余字段由宿主联动删除
    if (!provider) {
      setVllmLevelState((prev) => ({
        ...prev,
        [level]: { ...EMPTY_LEVEL },
      }));
      postToHost({ type: 'update_model_config', track: 'vllm', level, field: 'provider', value: '' });
      return;
    }
    const def = PROVIDER_DEFAULTS[provider as keyof typeof PROVIDER_DEFAULTS];
    const defaultModel = def?.vllmModel ?? def?.model ?? '';
    const defaultBaseUrl = def?.baseUrl ?? '';
    setVllmLevelState((prev) => {
      // Provider 未变 → 不重置 model / baseUrl，与宿主的幂等处理保持一致
      if (prev[level]?.provider === provider) return prev;
      return {
        ...prev,
        [level]: { ...prev[level], provider, model: defaultModel, baseUrl: defaultBaseUrl },
      };
    });
    postToHost({ type: 'update_model_config', track: 'vllm', level, field: 'provider', value: provider });
  }, [markEdited]);

  const updateLlmLevel = useCallback((level: 1 | 2 | 3, field: 'provider' | 'apiKey' | 'model' | 'baseUrl' | 'reasoningModel' | 'contextWindow', value: string) => {
    updateField(setLlmLevelState, 'llm', level, field, value);
  }, [updateField]);

  const updateVllmLevel = useCallback((level: 1 | 2 | 3, field: 'provider' | 'apiKey' | 'model' | 'baseUrl' | 'reasoningModel' | 'contextWindow', value: string) => {
    updateField(setVllmLevelState, 'vllm', level, field, value);
  }, [updateField]);

  const clearLlmApiKey = useCallback((level: 1 | 2 | 3) => {
    clearApiKey(setLlmLevelState, 'llm', level);
  }, [clearApiKey]);

  const clearVllmApiKey = useCallback((level: 1 | 2 | 3) => {
    clearApiKey(setVllmLevelState, 'vllm', level);
  }, [clearApiKey]);

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <ViewHeader title="设置" onBack={onBack} />
      {/* Step 21: 搜索输入框 */}
      <div className="px-4 pt-2">
        <input type="text" className="settings__search-input" placeholder="🔍 搜索设置项..." value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)} />
      </div>
      <Tab tabs={SETTINGS_TABS} activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* ────────── LLM 三级配置 ────────── */}
        {activeTab === 'llm' && (
          <div className="space-y-3">
            <p className="text-xs text-vscode-fg/50 mb-2">
              配置编码 AI 的模型链。优先使用 Level 1，不可用时自动降级。
            </p>
            {LEVEL_META.map(({ level, title, desc, required }) => {
              const cfg = llmLevelState[level];
              if (!cfg) return null;
              const expanded = llmLevelExpanded[level];
              return (
                <LevelCard
                  key={`llm-l${level}`}
                  level={level}
                  title={title}
                  desc={desc}
                  required={required}
                  expanded={!!expanded}
                  configured={!!cfg.provider}
                  onToggle={() =>
                    setLlmLevelExpanded((prev) => ({ ...prev, [level]: !prev[level] }))
                  }
                >
                  <ProviderConfigPanel
                    providerId={cfg.provider}
                    apiKey={cfg.apiKey}
                    onApiKeyChange={(v) => updateLlmLevel(level, 'apiKey', v)}
                    apiKeySet={cfg.apiKeySet}
                    onApiKeyClear={() => clearLlmApiKey(level)}
                    baseUrl={cfg.baseUrl}
                    onBaseUrlChange={(v) => updateLlmLevel(level, 'baseUrl', v)}
                    model={cfg.model}
                    onModelChange={(v) => updateLlmLevel(level, 'model', v)}
                    onProviderChange={(v) => updateLlmProvider(level, v)}
                    contextWindow={cfg.contextWindow}
                    onContextWindowChange={(v) => updateLlmLevel(level, 'contextWindow', v)}
                    contextWindowEffective={cfg.contextWindowEffective}
                    modelOptions={llmModelOptions[level]?.models}
                    modelOptionsProvider={llmModelOptions[level]?.provider}
                    testing={testStates[testKey('llm', level)]?.status === 'testing'}
                    testResult={testResultOf('llm', level)}
                    testError={testStates[testKey('llm', level)]?.error}
                    onTestConnection={() => handleTest('llm', level)}
                    track="llm"
                  />
                </LevelCard>
              );
            })}
          </div>
        )}

        {/* ────────── 视觉模型 ────────── */}
        {activeTab === 'vllm' && (
          <div className="space-y-3">
            <p className="text-xs text-vscode-fg/50 mb-2">
              截图粘贴时用于理解图像内容，可选。若未配置则使用 LLM 主模型处理图像。
            </p>
            {VLLM_LEVEL_META.map(({ level, title, desc, required }) => {
              const cfg = vllmLevelState[level];
              if (!cfg) return null;
              const expanded = vllmLevelExpanded[level];
              return (
                <LevelCard
                  key={`vllm-l${level}`}
                  level={level}
                  title={title}
                  desc={desc}
                  required={required}
                  expanded={!!expanded}
                  configured={!!cfg.provider}
                  onToggle={() =>
                    setVllmLevelExpanded((prev) => ({ ...prev, [level]: !prev[level] }))
                  }
                >
                  <ProviderConfigPanel
                    providerId={cfg.provider}
                    apiKey={cfg.apiKey}
                    onApiKeyChange={(v) => updateVllmLevel(level, 'apiKey', v)}
                    apiKeySet={cfg.apiKeySet}
                    onApiKeyClear={() => clearVllmApiKey(level)}
                    baseUrl={cfg.baseUrl}
                    onBaseUrlChange={(v) => updateVllmLevel(level, 'baseUrl', v)}
                    model={cfg.model}
                    onModelChange={(v) => updateVllmLevel(level, 'model', v)}
                    onProviderChange={(v) => updateVllmProvider(level, v)}
                    contextWindow={cfg.contextWindow}
                    onContextWindowChange={(v) => updateVllmLevel(level, 'contextWindow', v)}
                    contextWindowEffective={cfg.contextWindowEffective}
                    modelOptions={vllmModelOptions[level]?.models}
                    modelOptionsProvider={vllmModelOptions[level]?.provider}
                    testing={testStates[testKey('vllm', level)]?.status === 'testing'}
                    testResult={testResultOf('vllm', level)}
                    testError={testStates[testKey('vllm', level)]?.error}
                    onTestConnection={() => handleTest('vllm', level)}
                    track="vllm"
                  />
                </LevelCard>
              );
            })}
          </div>
        )}

        {/* ────────── 索引配置 ────────── */}
        {activeTab === 'index' && (
          <div className="space-y-5">
            <p className="text-xs text-vscode-fg/50">
              配置代码库索引的嵌入引擎。三种引擎向量维度不同（384 / 1024 / 768），切换后旧向量自动失效，后台约 3 秒后自动重建索引。
            </p>
            <Section title="嵌入引擎">
              <SettingRow label="嵌入引擎" description="默认 local-bert，完全离线、零成本">
                <select
                  className="px-2 py-1 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border"
                  value={embedState.provider}
                  onChange={(e) => updateEmbedField('provider', e.target.value)}
                >
                  <option value="local-bert">local-bert（本地，默认）</option>
                  <option value="dashscope">dashscope（云端）</option>
                  <option value="ollama">ollama（本地服务）</option>
                  <option value="bm25">bm25（无模型，词法）</option>
                </select>
              </SettingRow>

              {embedState.provider === 'dashscope' && (
                <>
                  <p className="text-xs text-vscode-fg/40 border rounded p-2 bg-vscode-sidebar-bg/50">
                    云端模式：需 API Key（devSeeker.qwenVl.apiKey，与 Qwen-VL 共用）；代码片段将上传至阿里云 DashScope。
                    建索引快（1-3 分钟），语义更丰富（1024 维）。
                  </p>
                  <SettingRow label="Base URL" description="留空使用默认百炼兼容端点">
                    <input
                      type="text"
                      className="w-72 px-2 py-1 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border focus:outline-none focus:ring-1 focus:ring-vscode-focus"
                      value={embedState.baseUrl}
                      onChange={(e) => updateEmbedField('baseUrl', e.target.value)}
                      placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                    />
                  </SettingRow>
                  <SettingRow label="模型名" description="留空使用默认 text-embedding-v3">
                    <input
                      type="text"
                      className="w-72 px-2 py-1 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border focus:outline-none focus:ring-1 focus:ring-vscode-focus"
                      value={embedState.model}
                      onChange={(e) => updateEmbedField('model', e.target.value)}
                      placeholder="text-embedding-v3"
                    />
                  </SettingRow>
                </>
              )}

              {embedState.provider === 'ollama' && (
                <>
                  <p className="text-xs text-vscode-fg/40 border rounded p-2 bg-vscode-sidebar-bg/50">
                    Ollama 模式：需本地已启动 Ollama 服务并拉取嵌入模型（默认 nomic-embed-text）。完全离线、零成本，查询毫秒级。
                  </p>
                  <SettingRow label="Base URL" description="留空使用默认本机地址">
                    <input
                      type="text"
                      className="w-72 px-2 py-1 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border focus:outline-none focus:ring-1 focus:ring-vscode-focus"
                      value={embedState.baseUrl}
                      onChange={(e) => updateEmbedField('baseUrl', e.target.value)}
                      placeholder="http://127.0.0.1:11434"
                    />
                  </SettingRow>
                  <SettingRow label="模型名" description="留空使用默认 nomic-embed-text">
                    <input
                      type="text"
                      className="w-72 px-2 py-1 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border focus:outline-none focus:ring-1 focus:ring-vscode-focus"
                      value={embedState.model}
                      onChange={(e) => updateEmbedField('model', e.target.value)}
                      placeholder="nomic-embed-text"
                    />
                  </SettingRow>
                </>
              )}

              {(embedState.provider === 'dashscope' || embedState.provider === 'ollama') && (
                <>
                  <SettingRow label="向量维度" description="留空使用引擎默认">
                    <input
                      type="number"
                      className="w-28 px-2 py-1 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border focus:outline-none focus:ring-1 focus:ring-vscode-focus"
                      value={embedState.dimension}
                      onChange={(e) => updateEmbedField('dimension', e.target.value)}
                      placeholder={embedState.provider === 'dashscope' ? '1024' : '768'}
                    />
                  </SettingRow>
                  <SettingRow label="批大小" description="留空使用引擎默认">
                    <input
                      type="number"
                      className="w-28 px-2 py-1 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border focus:outline-none focus:ring-1 focus:ring-vscode-focus"
                      value={embedState.batchSize}
                      onChange={(e) => updateEmbedField('batchSize', e.target.value)}
                      placeholder={embedState.provider === 'dashscope' ? '10' : '4'}
                    />
                  </SettingRow>
                  <SettingRow label="超时（ms）" description="留空使用引擎默认">
                    <input
                      type="number"
                      className="w-28 px-2 py-1 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border focus:outline-none focus:ring-1 focus:ring-vscode-focus"
                      value={embedState.timeoutMs}
                      onChange={(e) => updateEmbedField('timeoutMs', e.target.value)}
                      placeholder={embedState.provider === 'dashscope' ? '60000' : '30000'}
                    />
                  </SettingRow>
                </>
              )}

              <div className="mt-3 space-y-1 text-xs text-vscode-fg/40">
                <div>• 维度：local-bert 384 / dashscope 1024（text-embedding-v3）/ ollama 768（nomic-embed-text）</div>
                <div>• 切换引擎后旧向量自动失效（不会计算错误），约 3 秒后后台自动重建索引</div>
                <div>• 云端模式代码片段会上传至所选服务商；local-bert / ollama 完全离线</div>
              </div>
            </Section>
          </div>
        )}

        {/* ────────── 通用 ────────── */}
        {activeTab === 'general' && (
          <div className="space-y-5">
            <Section title="联网搜索">
              <SettingRow label="默认搜索 Provider" description="按查询语言自动路由">
                <select
                  className="px-2 py-1 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border"
                  value={searchProvider}
                  onChange={(e) => {
                    setSearchProvider(e.target.value);
                    persistSearchField('defaultProvider', e.target.value);
                  }}
                >
                  <option value="auto">auto（自动）</option>
                  <option value="tavily">Tavily（英文优先）</option>
                  <option value="bocha">博查（中文优先）</option>
                </select>
              </SettingRow>
              <div className="space-y-3 mt-3">
                <div className="space-y-1">
                  <label className="text-xs text-vscode-fg/60">Tavily API Key（支持多个，每行一个）</label>
                  <textarea
                    className="w-full px-3 py-2 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border focus:outline-none focus:ring-2 focus:ring-vscode-focus resize-y min-h-[60px]"
                    placeholder={"tavily-xxx\ntavily-yyy"}
                    value={tavilyKeys}
                    onChange={(e) => {
                      setTavilyKeys(e.target.value);
                      persistSearchField('tavilyKeys', e.target.value);
                    }}
                    rows={3}
                  />
                  <p className="text-xs text-vscode-fg/40">英文场景优先，1000 次/月免费。多个 Key 分行填写，系统自动随机选择 + 故障切换。</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-vscode-fg/60">博查 Bocha API Key（支持多个，每行一个）</label>
                  <textarea
                    className="w-full px-3 py-2 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border focus:outline-none focus:ring-2 focus:ring-vscode-focus resize-y min-h-[60px]"
                    placeholder={"bocha-xxx\nbocha-yyy"}
                    value={bochaKeys}
                    onChange={(e) => {
                      setBochaKeys(e.target.value);
                      persistSearchField('bochaKeys', e.target.value);
                    }}
                    rows={3}
                  />
                  <p className="text-xs text-vscode-fg/40">中文场景优先。多个 Key 分行填写，系统自动随机选择 + 故障切换。</p>
                </div>
              </div>
            </Section>

            <Separator />

            <Section title="通用">
              <SettingRow label="最大循环轮次" description="单任务最大循环轮次（25-500）">
                <input
                  type="number"
                  defaultValue={150}
                  min={25}
                  max={500}
                  className="w-20 px-2 py-1 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border"
                />
              </SettingRow>
            </Section>
          </div>
        )}

        {/* ────────── 审批 ────────── */}
        {activeTab === 'approval' && (
          <Section title="工具审批策略">
            <AutoApproveBar />
            <div className="mt-4 text-xs text-vscode-fg/40">
              审批策略可通过 .dualmind/approval-policy.yaml 文件进一步自定义。
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

// ─── 子组件 ───

/** 可折叠分级卡片 */
function LevelCard({
  level,
  title,
  desc,
  required,
  expanded,
  configured,
  onToggle,
  children,
}: {
  level: number;
  title: string;
  desc: string;
  required: boolean;
  expanded: boolean;
  configured: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(
      'rounded-lg border overflow-hidden',
      expanded ? 'border-vscode-focus/30' : 'border-vscode-input-border',
      !configured ? 'opacity-70' : '',
    )}>
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center justify-between w-full px-4 py-3 text-left cursor-pointer hover:bg-vscode-sidebar-bg transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-vscode-fg/50 w-5">L{level}</span>
          <span className="text-sm font-medium text-vscode-fg">{title}</span>
          {!required && !configured && (
            <span className="text-xs text-vscode-fg/40">（未配置）</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {required && <span className="text-xs text-orange-500">必填</span>}
          <span className="text-xs text-vscode-fg/30">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-xs text-vscode-fg/40">{desc}</p>
          {children}
        </div>
      )}
    </div>
  );
}

/** 可折叠分段（用于通用 tab） */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm font-medium text-vscode-fg mb-3 cursor-pointer"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {title}
      </button>
      {open && <div className="pl-2">{children}</div>}
    </div>
  );
}

/** 设置行 */
function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-vscode-fg">{label}</div>
        {description && <div className="text-xs text-vscode-fg/50">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
