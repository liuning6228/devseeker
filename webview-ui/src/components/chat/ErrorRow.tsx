import React from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface ErrorRowProps {
  code?: string;
  message: string;
  onRetry?: () => void;
  ctaLabel?: string;
  ctaAction?: () => void;
}

/**
 * ErrorRow — 带重试按钮的错误卡片
 * 用于工具执行失败时的渲染：显示错误码 + 消息 + 重试/操作按钮。
 */
export function ErrorRow({ code, message, onRetry, ctaLabel, ctaAction }: ErrorRowProps) {
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
      <div className="flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          {code && (
            <div className="text-xs text-red-500/70 font-mono mb-1">{code}</div>
          )}
          <div className="text-sm text-vscode-fg whitespace-pre-wrap">{message}</div>
        </div>
      </div>
      {(onRetry || ctaAction) && (
        <div className="flex gap-2 mt-2 ml-6">
          {onRetry && (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded
                         bg-vscode-btn-bg text-vscode-btn-fg hover:bg-vscode-btn-hover-bg cursor-pointer"
            >
              <RotateCcw className="h-3 w-3" />
              重试
            </button>
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
