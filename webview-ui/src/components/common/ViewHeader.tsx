import React from 'react';
import { cn } from '../../lib/utils.js';

interface ViewHeaderProps {
  title: string;
  onBack?: () => void;
  actions?: React.ReactNode;
  className?: string;
}

/**
 * ViewHeader — 视图标题栏
 * 用于每个独立页面顶部：标题 + 返回按钮 + 右侧操作按钮插槽
 */
export function ViewHeader({ title, onBack, actions, className }: ViewHeaderProps) {
  return (
    <div className={cn('flex items-center justify-between px-4 py-3 border-b border-vscode-input-border', className)}>
      <div className="flex items-center gap-2">
        {onBack && (
          <button
            onClick={onBack}
            className="p-1 rounded hover:bg-vscode-sidebar-bg cursor-pointer"
            title="返回"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5m7-7-7 7 7 7" />
            </svg>
          </button>
        )}
        <h2 className="text-base font-semibold text-vscode-fg">{title}</h2>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
