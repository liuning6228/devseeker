import React from 'react';
import { cn } from '../../lib/utils.js';

interface LightMarkdownProps {
  text: string;
  className?: string;
}

/**
 * LightMarkdown — 轻量 Markdown 行内渲染
 *
 * 仅支持基本 inline 语法：粗体、斜体、链接、行内代码。
 * 用于消息摘要、ToolCard 折叠状态的简短文本展示。
 * 完整的 Markdown 渲染由 MarkdownBlock 处理。
 */
export function LightMarkdown({ text, className }: LightMarkdownProps) {
  const html = React.useMemo(() => {
    let result = escapeHtml(text);

    // 粗体 **text** 或 __text__
    result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    result = result.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // 斜体 *text* 或 _text_
    result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');
    result = result.replace(/_(.+?)_/g, '<em>$1</em>');

    // 行内代码 `code`
    result = result.replace(/`(.+?)`/g, '<code class="text-xs px-1 py-0.5 rounded bg-vscode-sidebar-bg font-mono">$1</code>');

    // 链接 [text](url)
    result = result.replace(
      /\[(.+?)\]\((https?:\/\/.+?)\)/g,
      '<a href="$2" class="text-vscode-btn-bg underline">$1</a>',
    );

    return result;
  }, [text]);

  return (
    <span
      className={cn('text-sm text-vscode-fg', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
