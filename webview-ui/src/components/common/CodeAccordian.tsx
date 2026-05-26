import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { CopyButton } from './CopyButton.js';

interface CodeAccordianProps {
  title: string;
  code: string;
  language?: string;
  defaultOpen?: boolean;
  className?: string;
}

/**
 * CodeAccordian — 可折叠代码面板
 *
 * 参考 Cline CodeAccordian.tsx。
 * 适用于 Markdown 渲染中嵌入的代码块、diff 等。
 * 头部有标题 + 行数统计 + 复制按钮，点击可折叠/展开。
 */
export function CodeAccordian({
  title,
  code,
  language,
  defaultOpen = false,
  className,
}: CodeAccordianProps) {
  const [open, setOpen] = useState(defaultOpen);
  const lineCount = code.split('\n').length;

  return (
    <div className={cn('rounded border border-vscode-input-border overflow-hidden', className)}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full px-3 py-2 bg-vscode-sidebar-bg hover:bg-vscode-sidebar-bg/80 cursor-pointer text-sm"
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-vscode-fg/50" /> : <ChevronRight className="h-4 w-4 shrink-0 text-vscode-fg/50" />}
          <span className="truncate text-vscode-fg">{title}</span>
          <span className="text-xs text-vscode-fg/40 whitespace-nowrap">({lineCount} 行)</span>
          {language && (
            <span className="text-xs text-vscode-fg/50 uppercase">{language}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <CopyButton text={code} />
        </div>
      </button>
      {open && (
        <pre className="overflow-x-auto border-t border-vscode-input-border">
          <code className="block text-xs font-mono leading-5 p-3">{code}</code>
        </pre>
      )}
    </div>
  );
}
