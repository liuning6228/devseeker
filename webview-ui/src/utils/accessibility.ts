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

/**
 * Step 10: 创建屏幕阅读器实时区域，播报动态内容
 */
export function ariaLiveRegion(content: string, polite: boolean = true): void {
  const region = document.createElement('div');
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', polite ? 'polite' : 'assertive');
  region.setAttribute('aria-atomic', 'true');
  region.className = 'sr-only';
  region.textContent = content;
  document.body.appendChild(region);
  setTimeout(() => {
    if (region.parentNode) document.body.removeChild(region);
  }, 1000);
}

/**
 * Step 10: 向屏幕阅读器播报消息
 */
export function announceToScreenReader(message: string): void {
  ariaLiveRegion(message, true);
}

/**
 * Step 10: 生成唯一 ID（用于 aria-labelledby / aria-describedby）
 */
export function generateAriaId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).substring(2, 9)}`;
}
