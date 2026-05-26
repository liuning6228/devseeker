import React from 'react';
import { Webhook, CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface HookMessageProps {
  name: string;
  status: 'passed' | 'rejected' | 'skipped';
  exitCode?: number;
  output?: string;
  className?: string;
}

/**
 * HookMessage — Hook 执行结果卡片
 *
 * 展示 Hook 引擎的执行结果：
 * - 绿色 = 通过
 * - 红色 = 拒绝
 * - 灰色 = 跳过
 */
export function HookMessage({ name, status, exitCode, output, className }: HookMessageProps) {
  const [expanded, setExpanded] = React.useState(status === 'rejected');

  const icon = status === 'passed' ? <CheckCircle2 className="h-4 w-4 text-green-500" />
    : status === 'rejected' ? <XCircle className="h-4 w-4 text-red-500" />
    : <MinusCircle className="h-4 w-4 text-vscode-fg/40" />;

  const bg = status === 'passed' ? 'bg-green-500/5 border-green-500/20'
    : status === 'rejected' ? 'bg-red-500/5 border-red-500/20'
    : 'bg-vscode-sidebar-bg/30';

  const label = status === 'passed' ? '通过'
    : status === 'rejected' ? '拒绝'
    : '跳过';

  return (
    <div className={cn('rounded-lg border', bg, className)}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full px-3 py-2 cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Webhook className="h-4 w-4 text-vscode-fg/50 shrink-0" />
          <span className="text-sm text-vscode-fg truncate">{name}</span>
          <span className={cn(
            'text-xs px-1.5 py-0.5 rounded shrink-0',
            status === 'passed' ? 'bg-green-500/10 text-green-600' :
            status === 'rejected' ? 'bg-red-500/10 text-red-500' :
            'bg-vscode-sidebar-bg text-vscode-fg/50',
          )}>
            {label}
          </span>
          {exitCode !== undefined && (
            <span className="text-xs text-vscode-fg/40 shrink-0">exit code: {exitCode}</span>
          )}
        </div>
      </button>
      {expanded && output && (
        <pre className="px-3 py-2 text-xs font-mono text-vscode-fg/70 overflow-x-auto border-t border-vscode-input-border">
          {output}
        </pre>
      )}
    </div>
  );
}
