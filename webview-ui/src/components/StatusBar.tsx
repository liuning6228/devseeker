import type { ReactNode } from 'react';
import type { ProviderStatusPayload } from '../protocol';
import type { ContextStatsSnapshot } from '../state/reducer';
import type { View } from '../context/ExtensionStateContext';
import { GearMenu, type GearMenuAction } from './GearMenu';

export interface StatusBarProps {
  provider?: ProviderStatusPayload;
  gearActions: GearMenuAction[];
  badges?: ReactNode;
  onNewSession?: () => void;
  onToggleDrawer?: () => void;
  drawerVisible?: boolean;
  sessionCount?: number;
  /** 导航回调（首页/历史） */
  onNavigate?: (view: View) => void;
  /** 当前视图 */
  currentView?: View;
}

/**
 * StatusBar — 顶部工具栏
 *
 * 左侧：连接指示器 + 品牌名 + 徽章 + 首页按钮 + 历史按钮
 * 右侧：新建会话 + 会话历史抽屉 + 齿轮菜单
 */
export function StatusBar({
  provider,
  gearActions,
  badges,
  onNewSession,
  onToggleDrawer,
  drawerVisible,
  sessionCount,
  onNavigate,
  currentView,
}: StatusBarProps): JSX.Element {
  const ok = provider?.ok === true;
  const providerLabel = provider
    ? `${provider.providerId ?? 'provider'} · ${ok ? 'ok' : provider.errorMessage ?? 'offline'}`
    : 'provider · unknown';

  return (
    <div className="statusbar">
      <span
        className={`statusbar__indicator ${ok ? 'statusbar__indicator--ok' : 'statusbar__indicator--err'}`}
        title={providerLabel}
      >
        ●
      </span>
      <span className="statusbar__brand">DevSeeker</span>
      {badges && <span className="statusbar__badges">{badges}</span>}

      {/* 导航按钮：首页 / 历史 */}
      {onNavigate && (
        <>
          <button
            type="button"
            className={`statusbar__action ${currentView === 'welcome' ? 'is-active' : ''}`}
            title="首页"
            onClick={() => onNavigate('welcome')}
          >
            🏠
          </button>
          <button
            type="button"
            className={`statusbar__action ${currentView === 'history' ? 'is-active' : ''}`}
            title="历史会话"
            onClick={() => onNavigate('history')}
          >
            🕐
          </button>
        </>
      )}

      <span className="statusbar__spacer" />

      {onNewSession && (
        <button
          type="button"
          className="statusbar__action"
          title="新建会话"
          onClick={onNewSession}
        >
          +
        </button>
      )}
      {onToggleDrawer && (
        <button
          type="button"
          className={`statusbar__action ${drawerVisible ? 'is-active' : ''}`}
          title={drawerVisible ? '隐藏会话历史' : '显示会话历史'}
          onClick={onToggleDrawer}
        >
          📚
        </button>
      )}
      <GearMenu actions={gearActions} />
    </div>
  );
}

// W8.3 · Context 统计徽章
export function ContextBadge({ stats }: { stats: ContextStatsSnapshot }): JSX.Element {
  const ratio = stats.inputBudget > 0
    ? Math.min(stats.compressedTokens / stats.inputBudget, 1.2)
    : 0;
  const pct = Math.round(ratio * 100);
  const levelLabel: Record<ContextStatsSnapshot['level'], string> = {
    none: '',
    light: 'light',
    medium: 'medium',
    heavy: 'heavy',
  };
  const fillCls =
    ratio >= 0.95
      ? 'statusbar__ctx-fill statusbar__ctx-fill--danger'
      : ratio >= 0.85
        ? 'statusbar__ctx-fill statusbar__ctx-fill--warn'
        : ratio >= 0.70
          ? 'statusbar__ctx-fill statusbar__ctx-fill--hint'
          : 'statusbar__ctx-fill';
  const title =
    `Context: ${stats.compressedTokens.toLocaleString()} / ${stats.inputBudget.toLocaleString()} tokens` +
    (stats.level !== 'none'
      ? ` · 压缩 ${stats.level}（${stats.originalTokens.toLocaleString()} → ${stats.compressedTokens.toLocaleString()}, -${stats.savingsPercent}%）`
      : '');
  return (
    <span className="statusbar__ctx" title={title}>
      <span className="statusbar__ctx-label">ctx</span>
      <span className="statusbar__ctx-track" aria-hidden="true">
        <span
          className={fillCls}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </span>
      <span className="statusbar__ctx-pct">{pct}%</span>
      {stats.level !== 'none' && (
        <span className={`statusbar__ctx-badge statusbar__ctx-badge--${stats.level}`}>
          {levelLabel[stats.level]}
        </span>
      )}
    </span>
  );
}
