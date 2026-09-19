import { useState } from 'react';
import { Check, Key, Cpu, User } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { DebouncedTextField } from '../common/DebouncedTextField.js';

interface OnboardingViewProps {
  onComplete: (apiKey: string, model: string, provider: string, nickname: string) => void;
  className?: string;
}

/** Provider 选项：先选 Provider 再填 Key，更符合直觉 */
const PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: '推荐 · 高并发低成本' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o-mini', description: '高性价比' },
    ],
  },
  {
    id: 'qwen',
    label: '通义千问',
    models: [
      { id: 'qwen-plus', label: 'Qwen Plus', description: '均衡性能' },
    ],
  },
  {
    id: 'anthropic',
    label: 'Claude',
    models: [
      { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', description: 'Anthropic 旗舰' },
    ],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    models: [
      { id: 'MiniMax-M3', label: 'MiniMax M3', description: '1M 上下文旗舰' },
    ],
  },
  {
    id: 'kimi',
    label: 'Kimi',
    models: [
      { id: 'kimi-k3', label: 'Kimi K3', description: '2.8T 参数旗舰' },
    ],
  },
];

export function OnboardingView({ onComplete, className }: OnboardingViewProps) {
  const [selectedProvider, setSelectedProvider] = useState('deepseek');
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('deepseek-v4-flash');
  // 助手昵称（可选）：留空由 extension 侧回退默认名 "DevSeeker"
  const [nickname, setNickname] = useState('');

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
            <h2 className="text-lg font-semibold text-vscode-fg">初始设置</h2>
            <p className="text-sm text-vscode-fg/60">选择 Provider 并填入 API Key，为助手起一个昵称，即可开始使用</p>
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

        {/* 助手昵称（可选） */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <User className="h-4 w-4 text-vscode-fg/50" />
            <span className="text-xs text-vscode-fg/50 font-medium uppercase tracking-wider">
              助手昵称（可选）
            </span>
          </div>
          <DebouncedTextField
            value={nickname}
            onChange={setNickname}
            placeholder="留空则使用默认名称 DevSeeker（可稍后在设置页「通用」中修改）"
          />
        </div>
      </div>

      {/* 按钮 */}
      <div className="flex justify-between items-center w-full mt-8">
        <button
          type="button"
          onClick={() => onComplete('', '', selectedProvider, nickname)}
          className="text-sm text-vscode-fg/50 hover:text-vscode-fg/80 transition-colors cursor-pointer"
        >
          跳过，先逛逛
        </button>
        <Button onClick={() => onComplete(apiKey, selectedModel, selectedProvider, nickname)} disabled={!canComplete}>
          开始使用
        </Button>
      </div>
    </div>
  );
}
