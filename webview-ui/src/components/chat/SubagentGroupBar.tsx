import React from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Users, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { fmtDuration } from '../../utils/duration.js';
import type { SubagentState } from '../../state/reducer';

interface SubagentGroupBarProps {
  /** 同一条消息内的全部子代理状态（按出现顺序） */
  states: SubagentState[];
  /** 是否已折叠子代理卡片列表 */
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}

/**
 * SubagentGroupBar — 并行子代理分组条
 *
 * 当同一条消息内出现 ≥2 个子代理卡片时展示，聚合运行状态 / 步数 / 耗时，
 * 并支持一键折叠整组子代理卡片（仅 UI 展示，不影响数据）。
 */
export function SubagentGroupBar({ states, collapsed, onToggle, className }: SubagentGroupBarProps): JSX.Element {
  const running = states.filter((s) => s.status === 'running');
  const doneCount = states.filter((s) => s.status === 'done' && !s.partial).length;
  const partialCount = states.filter((s) => s.status === 'done' && s.partial).length;
  const failedCount = states.filter((s) => s.status === 'error').length;
  // 工具调用总数（分子与展示口径分离：轮次/预算用于进度，工具次数用于工作量）
  const totalSteps = states.reduce((sum, s) => sum + (s.toolCalls || s.steps.length), 0);
  const totalRounds = states.reduce((sum, s) => sum + (s.round ?? 0), 0);
  const budget = states.every((s) => s.maxTurns !== undefined)
    ? states.reduce((sum, s) => sum + (s.maxTurns ?? 0), 0)
    : undefined;

  // 1s ticker：只要有运行中的子代理就刷新「已用时」
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (running.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running.length]);

  // 运行中 → 最早启动者的已用时；全部结束 → 最长总耗时
  const elapsedMs = running.length > 0
    ? Math.max(...running.map((s) => (s.startTime !== undefined ? Math.max(0, now - s.startTime) : 0)))
    : Math.max(0, ...states.map((s) => s.durationMs ?? 0));

  return (
    <div
      className={cn(
        'subagent-group flex items-center gap-2 rounded-lg border border-vscode-input-border bg-vscode-sidebar-bg/40 px-3 py-1.5',
        className,
      )}
    >
      <Users className="h-3.5 w-3.5 text-vscode-fg/50 shrink-0" />
      <span className="text-xs font-medium text-vscode-fg/90 shrink-0">并行子代理 ×{states.length}</span>
      {running.length > 0 && (
        <span className="flex items-center gap-1 text-xs text-blue-500 shrink-0">
          <Loader2 className="h-3 w-3 animate-spin" />
          {running.length} 运行中
        </span>
      )}
      {doneCount > 0 && (
        <span className="flex items-center gap-1 text-xs text-green-500 shrink-0">
          <CheckCircle2 className="h-3 w-3" />
          {doneCount}
        </span>
      )}
      {partialCount > 0 && (
        <span className="flex items-center gap-1 text-xs text-amber-500 shrink-0" title="达到轮次上限，返回部分成果">
          <AlertTriangle className="h-3 w-3" />
          {partialCount} 部分完成
        </span>
      )}
      {failedCount > 0 && (
        <span className="flex items-center gap-1 text-xs text-red-500 shrink-0">
          <XCircle className="h-3 w-3" />
          {failedCount}
        </span>
      )}
      {totalSteps > 0 && (
        <span
          className="text-xs text-vscode-fg/40 shrink-0"
          title="合计消耗轮次 / 轮次预算 · 工具调用总次数"
        >
          {budget !== undefined && budget > 0
            ? `轮 ${totalRounds}/${budget} · 工具 ${totalSteps} 次`
            : `工具 ${totalSteps} 次`}
        </span>
      )}
      {elapsedMs > 0 && (
        <span
          className="text-xs text-vscode-fg/40 shrink-0 font-mono"
          title={running.length > 0 ? '最长已用时' : '最长总耗时'}
        >
          ⏱ {fmtDuration(elapsedMs)}
        </span>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="ml-auto flex items-center gap-1 text-xs text-vscode-fg/50 hover:text-vscode-fg/80 cursor-pointer shrink-0"
        title={collapsed ? '展开子代理卡片' : '折叠子代理卡片'}
      >
        {collapsed ? '展开' : '折叠'}
        <svg
          className={cn('w-3 h-3 transition-transform', !collapsed && 'rotate-180')}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    </div>
  );
}
