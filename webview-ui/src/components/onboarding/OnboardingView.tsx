import { useState } from 'react';
import { Check, Key, Cpu } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { DebouncedTextField } from '../common/DebouncedTextField.js';

interface OnboardingViewProps {
  onComplete: (apiKey: string, model: string) => void;
  className?: string;
}

/** Provider 选项：先选 Provider 再填 Key，更符合直觉 */
const PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat', description: '推荐 · 性价比最高' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', description: '性能强劲' },
    ],
  },
  {
    id: 'qwen',
    label: '通义千问',
    models: [
      { id: 'qwen-vl-max', label: 'Qwen-VL-Max', description: '多模态 · 截图能力' },
    ],
  },
];

export function OnboardingView({ onComplete, className }: OnboardingViewProps) {
  const [selectedProvider, setSelectedProvider] = useState('deepseek');
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('deepseek-chat');

  const currentProvider = PROVIDERS.find((p) => p.id === selectedProvider)!;
  const currentModels = currentProvider.models;
  // 切换 Provider 时自动重置到该 Provider 的第一个模型
  const handleSelectProvider = (id: string) => {
    setSelectedProvider(id);
    const p = PROVIDERS.find((x) => x.id === id)!;
    setSelectedModel(p.models[0].id);
  };

  const canComplete = apiKey.trim().length > 0;

  return (
    <div className={cn('flex flex-col items-center justify-center p-8 max-w-lg mx-auto', className)}>
      {/* Provider 选择 */}
      <div className="w-full space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-full bg-vscode-btn-bg/10">
            <Cpu className="h-6 w-6 text-vscode-btn-bg" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-vscode-fg">选择模型</h2>
            <p className="text-sm text-vscode-fg/60">选择 Provider 并填入 API Key，即可开始使用</p>
          </div>
        </div>

        {/* Provider 卡片 */}
        <div className="flex gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => handleSelectProvider(p.id)}
              className={cn(
                'flex-1 p-3 rounded-lg border cursor-pointer text-left transition-colors',
                selectedProvider === p.id
                  ? 'border-vscode-btn-bg bg-vscode-btn-bg/5'
                  : 'border-vscode-input-border hover:border-vscode-btn-bg/50',
              )}
            >
              <div className="text-sm font-medium text-vscode-fg">{p.label}</div>
            </button>
          ))}
        </div>

        {/* 模型详情 + Key 输入 */}
        <div className="space-y-3">
          <div className="text-xs text-vscode-fg/50 font-medium uppercase tracking-wider">
            {currentProvider.label} 模型
          </div>
          <div className="space-y-2">
            {currentModels.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelectedModel(m.id)}
                className={cn(
                  'w-full flex items-center justify-between p-3 rounded-lg border cursor-pointer text-left',
                  selectedModel === m.id
                    ? 'border-vscode-btn-bg bg-vscode-btn-bg/5'
                    : 'border-vscode-input-border hover:border-vscode-btn-bg/50',
                )}
              >
                <div>
                  <div className="text-sm font-medium text-vscode-fg">{m.label}</div>
                  <div className="text-xs text-vscode-fg/60">{m.description}</div>
                </div>
                {selectedModel === m.id && (
                  <Check className="h-4 w-4 text-vscode-btn-bg shrink-0" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* API Key */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-vscode-fg/50" />
            <span className="text-xs text-vscode-fg/50 font-medium uppercase tracking-wider">
              API Key
            </span>
          </div>
          <DebouncedTextField
            value={apiKey}
            onChange={setApiKey}
            placeholder="输入 API Key..."
            type="password"
          />
        </div>
      </div>

      {/* 按钮 */}
      <div className="flex justify-end w-full mt-8">
        <Button onClick={() => onComplete(apiKey, selectedModel)} disabled={!canComplete}>
          开始使用
        </Button>
      </div>
    </div>
  );
}
