import React from 'react';
import { cn } from '../../lib/utils.js';
import { Separator } from '../ui/separator.js';

interface Tab {
  id: string;
  label: string;
}

interface TabProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  className?: string;
}

/**
 * Tab — 页签切换组件
 */
export function Tab({ tabs, activeTab, onTabChange, className }: TabProps) {
  return (
    <div className={cn('flex border-b border-vscode-input-border', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            'px-4 py-2 text-sm cursor-pointer transition-colors',
            activeTab === tab.id
              ? 'text-vscode-btn-bg border-b-2 border-vscode-btn-bg font-medium'
              : 'text-vscode-fg/60 hover:text-vscode-fg hover:bg-vscode-sidebar-bg',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
