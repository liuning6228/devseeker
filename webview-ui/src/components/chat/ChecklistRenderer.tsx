import React from 'react';
import { CheckSquare, Square, ClipboardList } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

interface ChecklistRendererProps {
  items: ChecklistItem[];
  onToggle?: (id: string) => void;
  className?: string;
}

/**
 * ChecklistRenderer — 可勾选待办清单
 *
 * 渲染 todo_write 输出的 markdown 列表为可交互的勾选框。
 * 支持进度统计：「3/5 ⬜⬜⬜⬜⬜」
 */
export function ChecklistRenderer({ items, onToggle, className }: ChecklistRendererProps) {
  const checkedCount = items.filter((i) => i.checked).length;

  if (items.length === 0) return null;

  return (
    <div className={cn('rounded-lg border border-vscode-input-border overflow-hidden', className)}>
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 bg-vscode-sidebar-bg/50 border-b border-vscode-input-border">
        <ClipboardList className="h-4 w-4 text-vscode-fg/60" />
        <span className="text-sm font-medium text-vscode-fg">待办清单</span>
        <span className="text-xs text-vscode-fg/40 ml-auto">
          {checkedCount}/{items.length}
        </span>
      </div>

      {/* 列表 */}
      <div className="divide-y divide-vscode-input-border">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => onToggle?.(item.id)}
            disabled={!onToggle}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2 text-left cursor-pointer',
              'hover:bg-vscode-sidebar-bg/50',
            )}
          >
            {item.checked ? (
              <CheckSquare className="h-4 w-4 text-green-500 shrink-0" />
            ) : (
              <Square className="h-4 w-4 text-vscode-fg/40 shrink-0" />
            )}
            <span className={cn(
              'text-sm flex-1 min-w-0',
              item.checked && 'line-through text-vscode-fg/40',
            )}>
              {item.text}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
