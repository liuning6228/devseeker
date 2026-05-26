import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * W-UI4 · GearMenu · 单个齿轮图标展开 8 项菜单
 *
 * 设计原则：
 *  - 所有条目只消费现有 inbound（new_session / reindex / open_settings / set_mode / set_preferred_provider）
 *    或纯前端状态（会话历史抽屉 toggle、剪贴板）——零后端改动
 *  - 点击外部 / ESC 关闭菜单；菜单项点击后立即关闭
 *  - 模式 / 模型采用 cycle 策略（点一次 → 下一个），避免引入 submenu 复杂度
 */
export interface GearMenuAction {
  id: string;
  label: string;
  /** 右上角 meta，如"当前: agent"或"2 个会话" */
  meta?: string;
  icon?: string;
  onClick: () => void;
  /** 分隔线：在此项之前插入 hr */
  divider?: boolean;
  disabled?: boolean;
}

export interface GearMenuProps {
  actions: GearMenuAction[];
}

export function GearMenu({ actions }: GearMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部 / ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const runAction = useCallback((a: GearMenuAction) => {
    if (a.disabled) return;
    setOpen(false);
    // 下一帧触发，避免在 mousedown 冒泡回路里立刻更新状态导致抖动
    queueMicrotask(() => a.onClick());
  }, []);

  return (
    <div className="gear-menu" ref={rootRef}>
      <button
        type="button"
        className="gear-menu__trigger"
        aria-label="打开菜单"
        aria-expanded={open}
        title="菜单"
        onClick={() => setOpen((o) => !o)}
      >
        ⚙
      </button>
      {open && (
        <div className="gear-menu__panel" role="menu">
          {actions.map((a, i) => (
            <div key={a.id} className="gear-menu__row">
              {a.divider && i > 0 && <div className="gear-menu__divider" role="separator" />}
              <button
                type="button"
                className={`gear-menu__item ${a.disabled ? 'is-disabled' : ''}`}
                role="menuitem"
                onClick={() => runAction(a)}
                disabled={a.disabled}
              >
                {a.icon && <span className="gear-menu__icon" aria-hidden="true">{a.icon}</span>}
                <span className="gear-menu__label">{a.label}</span>
                {a.meta && <span className="gear-menu__meta">{a.meta}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
