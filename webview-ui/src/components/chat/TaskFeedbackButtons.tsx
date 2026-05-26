import React from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface TaskFeedbackButtonsProps {
  onFeedback?: (type: 'positive' | 'negative') => void;
  disabled?: boolean;
  className?: string;
}

/**
 * TaskFeedbackButtons — 👍/👎 反馈按钮
 * 附加在消息卡片底部，用户可对工具执行结果提供反馈。
 */
export function TaskFeedbackButtons({ onFeedback, disabled, className }: TaskFeedbackButtonsProps) {
  const [feedback, setFeedback] = React.useState<'positive' | 'negative' | null>(null);

  const handleFeedback = (type: 'positive' | 'negative') => {
    if (disabled || feedback) return;
    setFeedback(type);
    onFeedback?.(type);
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <button
        onClick={() => handleFeedback('positive')}
        disabled={disabled || !!feedback}
        className={cn(
          'p-1 rounded cursor-pointer transition-colors',
          feedback === 'positive'
            ? 'text-green-500 bg-green-500/10'
            : 'text-vscode-fg/40 hover:text-vscode-fg hover:bg-vscode-sidebar-bg',
          disabled && 'cursor-not-allowed opacity-50',
        )}
        title="有帮助"
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => handleFeedback('negative')}
        disabled={disabled || !!feedback}
        className={cn(
          'p-1 rounded cursor-pointer transition-colors',
          feedback === 'negative'
            ? 'text-red-500 bg-red-500/10'
            : 'text-vscode-fg/40 hover:text-vscode-fg hover:bg-vscode-sidebar-bg',
          disabled && 'cursor-not-allowed opacity-50',
        )}
        title="没有帮助"
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
