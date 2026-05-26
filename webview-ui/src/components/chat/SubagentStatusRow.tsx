import React from 'react';
import { Brain, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface SubagentStep {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

interface SubagentStatusRowProps {
  /** 子代理名称 */
  name: string;
  /** 进度值 0-100 */
  progress?: number;
  /** 步骤列表 */
  steps?: SubagentStep[];
  /** 预计剩余时间文本 */
  eta?: string;
  /** 是否正在执行 */
  isRunning?: boolean;
  /** 结果摘要（完成后展示） */
  resultSummary?: string;
  className?: string;
}

/**
 * SubagentStatusRow — 子代理执行状态行
 *
 * 当主 Agent 通过 Agent 工具发起子代理时，在消息流中显示独立的状态行，
 * 实时展示子代理的执行进度和步骤列表。
 */
export function SubagentStatusRow({
  name,
  progress,
  steps = [],
  eta,
  isRunning,
  resultSummary,
  className,
}: SubagentStatusRowProps) {
  const [expanded, setExpanded] = React.useState(isRunning);

  // 完成后自动折叠
  React.useEffect(() => {
    if (!isRunning && resultSummary) {
      setExpanded(false);
    }
  }, [isRunning, resultSummary]);

  return (
    <div className={cn(
      'rounded-lg border overflow-hidden',
      isRunning ? 'border-blue-500/30 bg-blue-500/5' : 'border-vscode-input-border',
      className,
    )}>
      {/* 头部 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full px-3 py-2 cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className={cn(
            'p-1 rounded shrink-0',
            isRunning ? 'bg-blue-500/10' : 'bg-vscode-sidebar-bg',
          )}>
            {isRunning
              ? <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
              : <Brain className="h-4 w-4 text-vscode-fg/60" />
            }
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-vscode-fg truncate">
              {isRunning ? `${name} 思考中...` : name}
            </div>
            {resultSummary && !expanded && (
              <div className="text-xs text-vscode-fg/60 truncate">{resultSummary}</div>
            )}
          </div>
          {progress !== undefined && (
            <span className="text-xs text-vscode-fg/40 shrink-0">{progress}%</span>
          )}
          {eta && isRunning && (
            <span className="text-xs text-vscode-fg/40 shrink-0">预计 {eta}</span>
          )}
        </div>
        <svg className={cn('w-3 h-3 text-vscode-fg/40 transition-transform shrink-0', expanded && 'rotate-180')}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* 展开详情 */}
      {expanded && steps.length > 0 && (
        <div className="px-3 pb-2 space-y-1 border-t border-vscode-input-border pt-2">
          {steps.map((step, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              {step.status === 'done' && <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />}
              {step.status === 'running' && <Loader2 className="h-3 w-3 text-blue-500 animate-spin shrink-0" />}
              {step.status === 'error' && <XCircle className="h-3 w-3 text-red-500 shrink-0" />}
              {step.status === 'pending' && <div className="h-3 w-3 rounded-full border border-vscode-input-border shrink-0" />}
              <span className={cn(
                'text-vscode-fg/70',
                step.status === 'done' && 'text-green-600/70',
                step.status === 'error' && 'text-red-500',
              )}>
                {step.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
