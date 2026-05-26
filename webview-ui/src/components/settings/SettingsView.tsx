import React, { useCallback, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { ViewHeader } from '../common/ViewHeader.js';
import { Separator } from '../ui/separator.js';
import { ProviderConfigPanel } from './providers/ProviderConfigPanel.js';
import { AutoApproveBar } from './AutoApproveBar.js';
import { Tab } from '../common/Tab.js';

type SettingsViewProps = {
  onBack?: () => void;
  className?: string;
};

const SETTINGS_TABS = [
  { id: 'llm', label: 'LLM' },
  { id: 'vllm', label: '视觉模型' },
  { id: 'general', label: '通用' },
  { id: 'approval', label: '审批' },
];

// ─── Level 级别标签 ───
const LEVEL_META = [
  { level: 1 as const, title: '主力模型', desc: '日常编码使用，必填', required: true },
  { level: 2 as const, title: '备选模型', desc: '主模型不可用时降级', required: false },
  { level: 3 as const, title: '兜底模型', desc: '备选也不可用时保底，推荐 Ollama 本地模型', required: false },
];

export function SettingsView({ onBack, className }: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState('llm');

  // LLM 三级配置
  const [llmLevelState, setLlmLevelState] = useState<Record<number, {
    provider: string; model: string; apiKey: string; baseUrl: string;
  }>>({
    1: { provider: 'deepseek', model: 'deepseek-chat', apiKey: '', baseUrl: '' },
    2: { provider: '', model: '', apiKey: '', baseUrl: '' },
    3: { provider: '', model: '', apiKey: '', baseUrl: '' },
  });
  const [llmLevelExpanded, setLlmLevelExpanded] = useState<Record<number, boolean>>({ 1: true });

  // VLLM 类似
  const [vllmLevelState, setVllmLevelState] = useState<Record<number, {
    provider: string; model: string; apiKey: string; baseUrl: string;
  }>>({
    1: { provider: 'qwen', model: 'qwen-vl-max', apiKey: '', baseUrl: '' },
  });
  const [vllmLevelExpanded, setVllmLevelExpanded] = useState<Record<number, boolean>>({ 1: true });

  // 联网搜索
  const [tavilyKeys, setTavilyKeys] = useState('');
  const [bochaKeys, setBochaKeys] = useState('');
  const [searchProvider, setSearchProvider] = useState('auto');

  // LLM 连接测试
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<'idle' | 'success' | 'error'>('idle');
  const handleTestLlm = useCallback(() => {
    setLlmTesting(true);
    setLlmTestResult('idle');
    setTimeout(() => {
      const key = llmLevelState[1]?.apiKey;
      setLlmTesting(false);
      setLlmTestResult(key?.startsWith('sk-') ? 'success' : 'error');
    }, 1000);
  }, [llmLevelState]);

  // 通用更新单个字段
  const updateField = useCallback(
    (setFn: React.Dispatch<React.SetStateAction<Record<number, { provider: string; model: string; apiKey: string; baseUrl: string }>>>, level: number, field: string, value: string) => {
      setFn((prev) => ({
        ...prev,
        [level]: { ...prev[level], [field]: value },
      }));
    },
    [],
  );

  // 更新 LLM 某级 provider（同时重置 model + baseUrl）
  const updateLlmProvider = useCallback((level: number, provider: string) => {
    setLlmLevelState((prev) => ({
      ...prev,
      [level]: { ...prev[level], provider, model: '', apiKey: prev[level]?.apiKey ?? '', baseUrl: '' },
    }));
  }, []);

  // 更新 VLLM 某级 provider
  const updateVllmProvider = useCallback((level: number, provider: string) => {
    setVllmLevelState((prev) => ({
      ...prev,
      [level]: { ...prev[level], provider, model: '', apiKey: prev[level]?.apiKey ?? '', baseUrl: '' },
    }));
  }, []);

  const updateLlmLevel = useCallback((level: number, field: string, value: string) => {
    updateField(setLlmLevelState, level, field, value);
  }, [updateField]);

  const updateVllmLevel = useCallback((level: number, field: string, value: string) => {
    updateField(setVllmLevelState, level, field, value);
  }, [updateField]);

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <ViewHeader title="设置" onBack={onBack} />
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
                    providerId={cfg.provider || 'deepseek'}
                    apiKey={cfg.apiKey}
                    onApiKeyChange={(v) => updateLlmLevel(level, 'apiKey', v)}
                    baseUrl={cfg.baseUrl}
                    onBaseUrlChange={(v) => updateLlmLevel(level, 'baseUrl', v)}
                    model={cfg.model}
                    onModelChange={(v) => updateLlmLevel(level, 'model', v)}
                    onProviderChange={(v) => updateLlmProvider(level, v)}
                    testing={llmTesting}
                    testResult={llmTestResult}
                    onTestConnection={level === 1 ? handleTestLlm : undefined}
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
            {[1].map((level) => {
              const cfg = vllmLevelState[level];
              if (!cfg) return null;
              const expanded = vllmLevelExpanded[level];
              return (
                <LevelCard
                  key={`vllm-l${level}`}
                  level={level}
                  title="视觉模型"
                  desc="主力视觉模型"
                  required={false}
                  expanded={!!expanded}
                  configured={!!cfg.provider}
                  onToggle={() =>
                    setVllmLevelExpanded((prev) => ({ ...prev, [level]: !prev[level] }))
                  }
                >
                  <ProviderConfigPanel
                    providerId={cfg.provider || 'qwen'}
                    apiKey={cfg.apiKey}
                    onApiKeyChange={(v) => updateVllmLevel(level, 'apiKey', v)}
                    baseUrl={cfg.baseUrl}
                    onBaseUrlChange={(v) => updateVllmLevel(level, 'baseUrl', v)}
                    model={cfg.model}
                    onModelChange={(v) => updateVllmLevel(level, 'model', v)}
                    onProviderChange={(v) => updateVllmProvider(level, v)}
                    track="vllm"
                  />
                </LevelCard>
              );
            })}
          </div>
        )}

        {/* ────────── 通用 ────────── */}
        {activeTab === 'general' && (
          <div className="space-y-5">
            <Section title="嵌入引擎">
              <SettingRow label="嵌入引擎" description="代码库索引使用的嵌入模型">
                <select className="px-2 py-1 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border">
                  <option>local-bert（本地）</option>
                  <option>dashscope（在线）</option>
                  <option>bm25（无模型）</option>
                </select>
              </SettingRow>
            </Section>

            <Separator />

            <Section title="联网搜索">
              <SettingRow label="默认搜索 Provider" description="按查询语言自动路由">
                <select
                  className="px-2 py-1 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border"
                  value={searchProvider}
                  onChange={(e) => setSearchProvider(e.target.value)}
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
                    onChange={(e) => setTavilyKeys(e.target.value)}
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
                    onChange={(e) => setBochaKeys(e.target.value)}
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
