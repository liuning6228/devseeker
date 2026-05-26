import { useState, useEffect, useRef } from 'react';

interface CommandOutputRowProps {
  command: string;
  output: string;
  isStreaming?: boolean;
  onOpenTerminal?: () => void;
}

/**
 * CommandOutputRow — bash 命令输出展示
 * W-UI8 · 紧凑布局：边框变细、padding 缩小、文本更小
 */
export function CommandOutputRow({ command, output, isStreaming, onOpenTerminal }: CommandOutputRowProps) {
  const [expanded, setExpanded] = useState(true);
  const outputRef = useRef<HTMLPreElement>(null);

  // W-UI8 · 输出更新时自动滚动到底部
  useEffect(() => {
    if (outputRef.current && isStreaming) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output, isStreaming]);

  return (
    <div className="overflow-hidden">
      {/* 输出内容（命令已由 ToolCard header 展示，此处不重复） */}
      {expanded && (
        <pre
          ref={outputRef}
          className="px-2 py-1 text-[11px] font-mono text-vscode-fg/70 overflow-x-auto max-h-64 overflow-y-auto"
        >
          {output || (isStreaming ? '等待输出…' : '')}
        </pre>
      )}
    </div>
  );
}
