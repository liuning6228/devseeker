import React, { useState, useEffect } from 'react';
import { Lightbulb, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface FeatureTipProps {
  id: string;
  title: string;
  description: string;
  /** 是否自动定位到特定组件 */
  onDismiss?: (id: string) => void;
  className?: string;
}

const DISMISSED_TIPS_KEY = 'dualmind.dismissed_tips';

/**
 * FeatureTip — 首次使用提示气泡
 *
 * 当用户首次触发某工具时，在工具调用卡片下方弹出提示。
 * 仅展示一次（localStorage 持久化）。
 */
export function FeatureTip({ id, title, description, onDismiss, className }: FeatureTipProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const dismissed = new Set<string>(
      JSON.parse(localStorage.getItem(DISMISSED_TIPS_KEY) || '[]'),
    );
    if (!dismissed.has(id)) {
      setVisible(true);
    }
  }, [id]);

  const handleDismiss = () => {
    setVisible(false);
    const dismissed = new Set<string>(
      JSON.parse(localStorage.getItem(DISMISSED_TIPS_KEY) || '[]'),
    );
    dismissed.add(id);
    localStorage.setItem(DISMISSED_TIPS_KEY, JSON.stringify([...dismissed]));
    onDismiss?.(id);
  };

  if (!visible) return null;

  return (
    <div className={cn(
      'flex items-start gap-2 p-3 rounded-lg border border-blue-500/20 bg-blue-500/5',
      'animate-in fade-in slide-in-from-bottom-2',
      className,
    )}>
      <Lightbulb className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-vscode-fg">{title}</div>
        <div className="text-xs text-vscode-fg/60 mt-0.5">{description}</div>
      </div>
      <button
        onClick={handleDismiss}
        className="p-0.5 rounded text-vscode-fg/40 hover:text-vscode-fg hover:bg-blue-500/10 cursor-pointer shrink-0"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
