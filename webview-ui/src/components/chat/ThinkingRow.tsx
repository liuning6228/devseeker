import React from 'react';
import { cn } from '../../lib/utils.js';

interface ThinkingRowProps {
  text: string;
  isStreaming?: boolean;
  progress?: number; // 0-100
}

/**
 * ThinkingRow — 推理链展示
 * 用于展示 LLM 的 reasoning_content，可折叠展开。
 * 流式状态时显示进度指示器。
 */
export function ThinkingRow({ text, isStreaming, progress }: ThinkingRowProps) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="rounded-lg border border-vscode-input-border bg-vscode-sidebar-bg/50 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full px-3 py-2 text-xs text-vscode-fg/60 hover:bg-vscode-sidebar-bg cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {isStreaming && (
            <span className="inline-block w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
          )}
          <span>推理过程</span>
          {progress !== undefined && (
            <span className="text-vscode-fg/40">{progress}%</span>
          )}
        </div>
        <svg
          className={cn('w-3 h-3 transition-transform', expanded && 'rotate-180')}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {expanded && (
        <div className="px-3 py-2 text-xs text-vscode-fg/70 max-h-48 overflow-y-auto whitespace-pre-wrap border-t border-vscode-input-border">
          {text}
        </div>
      )}
    </div>
  );
}
