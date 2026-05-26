import React from 'react';
import { MessageSquare, Clock, Settings, Puzzle, Home, BookOpen } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import type { View } from '../../context/ExtensionStateContext.js';

interface NavItem {
  id: View;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'chat', label: '对话', icon: <MessageSquare className="h-5 w-5" /> },
  { id: 'welcome', label: '首页', icon: <Home className="h-5 w-5" /> },
  { id: 'history', label: '历史', icon: <Clock className="h-5 w-5" /> },
  { id: 'settings', label: '设置', icon: <Settings className="h-5 w-5" /> },
  { id: 'mcp', label: 'MCP', icon: <Puzzle className="h-5 w-5" /> },
  { id: 'rules', label: '规则', icon: <BookOpen className="h-5 w-5" /> },
];

interface NavbarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  className?: string;
}

/**
 * Navbar — 底部固定标签栏
 *
 * Phase 5b 导航入口，支持 6 个视图切换。
 * 使用 Lucide 图标 + VSCode 主题色。
 */
export function Navbar({ currentView, onNavigate, className }: NavbarProps) {
  return (
    <nav className={cn(
      'flex items-center border-t border-vscode-input-border bg-vscode-editor-background',
      'shrink-0 h-12 px-2',
      className,
    )}>
      {NAV_ITEMS.map((item) => {
        const isActive = currentView === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={cn(
              'flex flex-col items-center justify-center flex-1 h-full gap-0.5',
              'cursor-pointer transition-colors',
              isActive
                ? 'text-vscode-btn-bg'
                : 'text-vscode-fg/50 hover:text-vscode-fg hover:bg-vscode-sidebar-bg',
            )}
            title={item.label}
          >
            {item.icon}
            <span className="text-[10px] leading-none">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
