import React, { useState, useCallback } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface CopyButtonProps {
  text: string;
  className?: string;
}

export function CopyButton({ text, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 静默失败
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-1 text-xs rounded',
        'hover:bg-vscode-sidebar-bg cursor-pointer',
        copied ? 'text-green-500' : 'text-vscode-fg/60',
        className,
      )}
      title={copied ? '已复制' : '复制'}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? '已复制' : '复制'}
    </button>
  );
}
