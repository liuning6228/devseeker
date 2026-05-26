import React, { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '../../lib/utils.js';

interface CommandOption {
  id: string;
  label: string;
  description: string;
  icon?: string;
}

interface SlashCommandMenuProps {
  /** 可用命令列表 */
  commands: CommandOption[];
  /** 选中命令时回调 */
  onSelect: (command: CommandOption) => void;
  /** 菜单是否可见 */
  isOpen: boolean;
  /** 关闭菜单 */
  onClose: () => void;
  /** 触发位置（用于定位） */
  triggerRect?: DOMRect;
  className?: string;
}

const DEFAULT_COMMANDS: CommandOption[] = [
  { id: 'commit', label: '/commit', description: '标准化提交流程', icon: '📝' },
  { id: 'refactor', label: '/refactor', description: '跨文件重构接口', icon: '🔧' },
  { id: 'review', label: '/review', description: '代码评审', icon: '🔍' },
  { id: 'test', label: '/test', description: '运行验证', icon: '🧪' },
];

/**
 * SlashCommandMenu — / 命令候选列表弹出菜单
 *
 * 在 Composer 中检测到用户输入 / 时弹出，
 * 支持键盘选择（↑↓ + Enter）和鼠标点击。
 */
export function SlashCommandMenu({
  commands = DEFAULT_COMMANDS,
  onSelect,
  isOpen,
  onClose,
  triggerRect,
  className,
}: SlashCommandMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setSelectedIndex(0);
      return;
    }
  }, [isOpen]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % commands.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + commands.length) % commands.length);
    } else if (e.key === 'Enter' && commands[selectedIndex]) {
      e.preventDefault();
      onSelect(commands[selectedIndex]);
      onClose();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [isOpen, commands, selectedIndex, onSelect, onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!isOpen || commands.length === 0) return null;

  const top = triggerRect ? triggerRect.bottom + 4 : '100%';

  return (
    <div
      ref={listRef}
      className={cn(
        'absolute z-50 min-w-[200px] rounded-lg border border-vscode-input-border',
        'bg-vscode-bg shadow-lg overflow-hidden',
        className,
      )}
      style={{ top }}
    >
      <div className="p-1 space-y-0.5">
        {commands.map((cmd, i) => (
          <button
            key={cmd.id}
            onClick={() => {
              onSelect(cmd);
              onClose();
            }}
            onMouseEnter={() => setSelectedIndex(i)}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 text-sm rounded cursor-pointer text-left',
              i === selectedIndex
                ? 'bg-vscode-sidebar-bg text-vscode-fg'
                : 'text-vscode-fg/80 hover:bg-vscode-sidebar-bg/50',
            )}
          >
            {cmd.icon && <span className="text-base">{cmd.icon}</span>}
            <div className="flex-1 min-w-0">
              <div className="font-medium">{cmd.label}</div>
              <div className="text-xs text-vscode-fg/50">{cmd.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
