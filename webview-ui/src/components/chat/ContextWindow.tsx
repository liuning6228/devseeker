import React, { useState } from 'react';
import { Info } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Progress } from '../ui/progress.js';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '../ui/dialog.js';

interface ContextWindowProps {
  usedTokens: number;
  totalTokens: number;
  breakdown?: {
    prompt: number;
    completion: number;
    toolResults: number;
    systemPrompt: number;
  };
  className?: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * ContextWindow — Token 使用比例可视化进度条
 *
 * 颜色编码：
 * • < 60%  — 绿色
 * • 60-80% — 黄色
 * • > 80%  — 红色
 */
export function ContextWindow({
  usedTokens,
  totalTokens,
  breakdown,
  className,
}: ContextWindowProps) {
  const [showDetails, setShowDetails] = useState(false);
  const ratio = totalTokens > 0 ? (usedTokens / totalTokens) * 100 : 0;

  const barColor =
    ratio < 60 ? 'bg-green-500' :
    ratio < 80 ? 'bg-yellow-500' :
    'bg-red-500';

  return (
    <>
      {/* 进度条 */}
      <div
        className={cn('flex items-center gap-2 cursor-pointer group', className)}
        onClick={() => setShowDetails(true)}
        title="点击查看详细分布"
      >
        <Progress
          value={Math.min(ratio, 100)}
          className="h-1.5 flex-1"
          indicatorClassName={barColor}
        />
        <span
          className={cn(
            'text-xs font-mono whitespace-nowrap',
            ratio < 60 ? 'text-green-600' :
            ratio < 80 ? 'text-yellow-600' :
            'text-red-600',
          )}
        >
          {formatTokens(usedTokens)} / {formatTokens(totalTokens)}
        </span>
        <Info className="h-3 w-3 text-vscode-fg/40 group-hover:text-vscode-fg shrink-0" />
      </div>

      {/* 详细分布弹窗 */}
      <Dialog open={showDetails} onOpenChange={setShowDetails}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Token 使用详情</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {/* 比例进度条 */}
            <div className="flex items-center gap-3">
              <Progress value={Math.min(ratio, 100)} className="h-2 flex-1" indicatorClassName={barColor} />
              <span className={cn(
                'text-xs font-mono shrink-0',
                ratio < 60 ? 'text-green-600' :
                ratio < 80 ? 'text-yellow-600' :
                'text-red-600',
              )}>
                {ratio.toFixed(1)}%
              </span>
            </div>

            {/* 总体 */}
            <div className="flex justify-between text-vscode-fg/80 py-1">
              <span>总计</span>
              <span className="font-mono">{formatTokens(usedTokens)} / {formatTokens(totalTokens)}</span>
            </div>

            {/* 细分 */}
            {breakdown && (
              <>
                <div className="border-t border-vscode-input-border" />
                {([
                  ['Prompt tokens', breakdown.prompt],
                  ['Completion tokens', breakdown.completion],
                  ['Tool results', breakdown.toolResults],
                  ['System prompt', breakdown.systemPrompt],
                ] as const).map(([label, value]) => (
                  <div key={label} className="flex justify-between text-vscode-fg/60 text-xs py-0.5">
                    <span>{label}</span>
                    <span className="font-mono">{formatTokens(value)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
