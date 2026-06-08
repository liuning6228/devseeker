import { useEffect } from 'react';

interface ShortcutDef {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  handler: () => void;
  /** 在哪些场景下禁用 */
  disabledIn?: string[];
  description: string;
}

/**
 * useKeyboardShortcuts — 键盘快捷键 Hook
 * 只绑定 webview 内焦点可用快捷键，不拦截 VSCode 全局快捷键。
 * webview 内无法拦截的全局快捷键：Ctrl+N、Ctrl+Shift+P、Ctrl+` 等
 */
export function useKeyboardShortcuts(shortcuts: ShortcutDef[], context?: string) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      for (const s of shortcuts) {
        if (s.disabledIn?.includes(context || '')) continue;
        const ctrl = s.ctrl ?? false;
        const shift = s.shift ?? false;
        const alt = s.alt ?? false;
        const meta = s.meta ?? false;
        if (e.key.toLowerCase() !== s.key.toLowerCase()) continue;
        if (ctrl && !e.ctrlKey && !e.metaKey) continue;
        if (!ctrl && (e.ctrlKey || e.metaKey)) continue;
        if (shift && !e.shiftKey) continue;
        if (alt && !e.altKey) continue;
        e.preventDefault();
        e.stopPropagation();
        s.handler();
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, context]);
}
