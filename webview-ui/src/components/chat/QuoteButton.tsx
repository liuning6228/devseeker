import React from 'react';
import { MessageSquare, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface QuoteButtonProps {
  /** 被引用消息的文本摘要 */
  quotedText: string;
  onClick: () => void;
  className?: string;
}

/**
 * QuoteButton — 消息引用按钮
 *
 * 在每个用户/助手消息气泡上悬浮时显示。
 * 点击后将被引用消息摘要插入 Composer。
 */
export function QuoteButton({ quotedText, onClick, className }: QuoteButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'p-1 rounded text-vscode-fg/40 hover:text-vscode-btn-bg hover:bg-vscode-sidebar-bg cursor-pointer',
        className,
      )}
      title="引用此消息"
    >
      <MessageSquare className="h-3.5 w-3.5" />
    </button>
  );
}

interface QuotedMessagePreviewProps {
  /** 被引用的文本 */
  quotedText: string;
  /** 关闭引用预览 */
  onDismiss: () => void;
  className?: string;
}

/**
 * QuotedMessagePreview — 引用预览条
 *
 * 在 Composer 上方显示，展示被引用的消息摘要。
 * 用户可点击 ✕ 移除引用。
 */
export function QuotedMessagePreview({
  quotedText,
  onDismiss,
  className,
}: QuotedMessagePreviewProps) {
  return (
    <div className={cn(
      'flex items-start gap-2 px-3 py-2 rounded border border-vscode-input-border bg-vscode-sidebar-bg/50',
      className,
    )}>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-vscode-fg/50 mb-0.5">引用消息</div>
        <div className="text-sm text-vscode-fg/80 truncate">{quotedText}</div>
      </div>
      <button
        onClick={onDismiss}
        className="p-0.5 rounded text-vscode-fg/40 hover:text-vscode-fg hover:bg-vscode-sidebar-bg cursor-pointer shrink-0"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
