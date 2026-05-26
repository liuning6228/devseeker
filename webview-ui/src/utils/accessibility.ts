import React from 'react';

/**
 * 为所有按钮/链接添加 aria-label 的辅助函数
 *
 * 在 jsx 中调用：`aria-label={ariaLabel('关闭面板', 'ClosePanel')}`
 * 英文 label 用于测试定位，中文 label 用于屏幕阅读器。
 */
export function ariaLabel(zh: string, en?: string): string {
  return zh;  // 中文用户优先中文播报
}

/**
 * 焦点管理工具函数集
 */

/** 自动聚焦到 Composer 输入框 */
export function focusComposer(): void {
  const el = document.querySelector<HTMLTextAreaElement>('[data-composer]');
  el?.focus();
}

/** Modal 焦点陷阱 */
export function trapFocus(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  const focusable = container.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
