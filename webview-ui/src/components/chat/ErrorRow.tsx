import React from 'react';
import { AlertCircle, RotateCcw, WifiOff, Clock, ShieldOff, Wrench, HelpCircle } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface ErrorRowProps {
  code?: string;
  message: string;
  onRetry?: () => void;
  ctaLabel?: string;
  ctaAction?: () => void;
  /** Step 8: 错误分类，用于显示不同的图标和颜色 */
  category?: 'api' | 'network' | 'tool' | 'timeout' | 'auth' | 'unknown';
  /** Step 8: 重试剩余次数（-1 表示无限制） */
  retryCount?: number;
  /** Step 8: 最大重试次数 */
  maxRetries?: number;
}

/** 错误分类配置 */
const ERROR_CONFIG: Record<string, { icon: React.ReactNode; borderColor: string; bgColor: string }> = {
  api:     { icon: <AlertCircle className="h-4 w-4 shrink-0" />, borderColor: 'border-orange-500/30', bgColor: 'bg-orange-500/5' },
  network: { icon: <WifiOff className="h-4 w-4 shrink-0" />,     borderColor: 'border-yellow-500/30', bgColor: 'bg-yellow-500/5' },
  tool:    { icon: <Wrench className="h-4 w-4 shrink-0" />,       borderColor: 'border-red-500/30', bgColor: 'bg-red-500/5' },
  timeout: { icon: <Clock className="h-4 w-4 shrink-0" />,       borderColor: 'border-yellow-500/30', bgColor: 'bg-yellow-500/5' },
  auth:    { icon: <ShieldOff className="h-4 w-4 shrink-0" />,   borderColor: 'border-red-500/30', bgColor: 'bg-red-500/5' },
};

/**
 * ErrorRow — 带重试按钮的错误卡片（Step 8 增强）
 * 根据 category 显示不同图标和颜色（网络/权限/超时/API/工具）
 */
export function ErrorRow({ code, message, onRetry, ctaLabel, ctaAction, category, retryCount, maxRetries }: ErrorRowProps) {
  const cfg = category ? ERROR_CONFIG[category] : undefined;
  const iconEl = cfg?.icon ?? <HelpCircle className="h-4 w-4 shrink-0" />;
  const borderClass = cfg?.borderColor ?? 'border-red-500/30';
  const bgClass = cfg?.bgColor ?? 'bg-red-500/5';

  const isRetryExhausted = maxRetries !== undefined && retryCount !== undefined && retryCount >= maxRetries;

  return (
    <div className={cn('rounded-lg border p-3', borderClass, bgClass)}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5">{iconEl}</span>
        <div className="flex-1 min-w-0">
          {code && (
            <div className="text-xs text-red-500/70 font-mono mb-1">{code}</div>
          )}
          <div className="text-sm text-vscode-fg whitespace-pre-wrap">{message}</div>
        </div>
      </div>
      {(onRetry || ctaAction) && (
        <div className="flex gap-2 mt-2 ml-6">
          {onRetry && !isRetryExhausted && (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded
                         bg-vscode-btn-bg text-vscode-btn-fg hover:bg-vscode-btn-hover-bg cursor-pointer"
              title={maxRetries !== undefined && retryCount !== undefined ? `已重试 ${retryCount}/${maxRetries} 次` : undefined}
            >
              <RotateCcw className="h-3 w-3" />
              重试
            </button>
          )}
          {isRetryExhausted && (
            <span className="inline-flex items-center px-2.5 py-1 text-xs rounded bg-red-500/10 text-red-500">
              已达最大重试次数
            </span>
          )}
          {ctaAction && ctaLabel && (
            <button
              onClick={ctaAction}
              className="px-2.5 py-1 text-xs rounded border border-vscode-input-border
                         text-vscode-fg hover:bg-vscode-sidebar-bg cursor-pointer"
            >
              {ctaLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
