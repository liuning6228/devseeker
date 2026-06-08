import { useEffect, useRef } from 'react';

/**
 * useFocusTrap — React Hook 版本的焦点陷阱
 * 用于模态框、对话框、弹出面板
 *
 * 用法:
 *   const modalRef = useFocusTrap(true);
 *   return <div ref={modalRef} role="dialog" aria-modal="true">...</div>;
 */
export function useFocusTrap(active: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active || !containerRef.current) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement;
    const container = containerRef.current;
    const focusableSelectors = [
      'button:not([disabled])', '[href]', 'input:not([disabled])',
      'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
    ];
    const getFocusable = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(focusableSelectors.join(',')))
        .filter(el => el.offsetParent !== null);

    const focusFirst = () => {
      const elements = getFocusable();
      if (elements.length > 0) elements[0].focus();
    };
    const timer = setTimeout(focusFirst, 50);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    container.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(timer);
      container.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocusedRef.current) previouslyFocusedRef.current.focus();
    };
  }, [active]);

  return containerRef;
}
