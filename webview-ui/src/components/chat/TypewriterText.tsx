import React from 'react';

interface TypewriterTextProps {
  text: string;
  isStreaming: boolean;
  className?: string;
}

/**
 * TypewriterText — 流式文本实时显示
 *
 * 流式输出期间直接渲染全文 + 闪烁光标，不做逐字动画。
 * 非流式时直接渲染全文（由外部切换 MarkdownRenderer）。
 */
export function TypewriterText({ text, isStreaming, className }: TypewriterTextProps) {
  // 非流式直接显示全文
  if (!isStreaming) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className} style={{ whiteSpace: 'pre-wrap' }}>
      {text}
      <span className="inline-flex items-center gap-0.5 ml-0.5">
        <span className="w-[2px] h-[14px] bg-vscode-fg/70 animate-pulse" />
      </span>
    </span>
  );
}
