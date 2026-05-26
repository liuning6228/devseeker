import React, { useState } from 'react';
import { cn } from '../../lib/utils.js';
import { CopyButton } from './CopyButton.js';

interface CodeBlockProps {
  code: string;
  language?: string;
  maxHeight?: string;
  className?: string;
}

/**
 * CodeBlock — 可折叠的代码块
 *
 * 与 MarkdownBlock 不同，CodeBlock 默认折叠（仅展示前几行），
 * 适用于大段代码预览场景（如 write_file 的内容预览）。
 */
export function CodeBlock({ code, language, maxHeight = '200px', className }: CodeBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const lines = code.split('\n');
  const isLong = lines.length > 10;

  return (
    <div className={cn('rounded border border-vscode-input-border overflow-hidden', className)}>
      <div className="flex items-center justify-between px-2 py-1 bg-vscode-sidebar-bg border-b border-vscode-input-border">
        <div className="flex items-center gap-2">
          {language && (
            <span className="text-xs text-vscode-fg/50 uppercase">{language}</span>
          )}
          <span className="text-xs text-vscode-fg/40">{lines.length} 行</span>
        </div>
        <div className="flex items-center gap-1">
          <CopyButton text={code} />
          {isLong && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-vscode-fg/50 hover:text-vscode-fg cursor-pointer"
            >
              {expanded ? '收起' : '展开全部'}
            </button>
          )}
        </div>
      </div>
      <pre
        className="overflow-x-auto"
        style={{ maxHeight: expanded ? 'none' : maxHeight }}
      >
        <code className="block text-xs font-mono leading-5 p-2">{code}</code>
      </pre>
      {isLong && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full py-1 text-xs text-center text-vscode-fg/50 hover:text-vscode-fg bg-vscode-sidebar-bg/50 border-t border-vscode-input-border cursor-pointer"
        >
          展开全部（共 {lines.length} 行）
        </button>
      )}
    </div>
  );
}
