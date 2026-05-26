import React from 'react';
import { cn } from '../../lib/utils.js';

interface ScreenReaderAnnounceProps {
  text: string;
  className?: string;
}

/**
 * ScreenReaderAnnounce — 无障碍播报组件
 * 使用 aria-live="polite" 实时播报新消息/状态变更，
 * 对视觉用户不可见。
 */
export function ScreenReaderAnnounce({ text, className }: ScreenReaderAnnounceProps) {
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className={cn('sr-only', className)}
    >
      {text}
    </div>
  );
}
