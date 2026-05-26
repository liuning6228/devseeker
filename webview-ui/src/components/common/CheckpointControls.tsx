import React from 'react';
import { RotateCcw, History, Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { Separator } from '../ui/separator.js';

interface CheckpointItem {
  id: string;
  label: string;
  timestamp: number;
  files: number;
}

interface CheckpointControlsProps {
  checkpoints: CheckpointItem[];
  onRevert: (id: string) => void;
  onCompareDiff?: (id: string) => void;
  onCleanup?: (ids: string[]) => void;
  className?: string;
}

/**
 * CheckpointControls — 快照列表 + 恢复按钮
 *
 * 展示当前任务的 Checkpoint 时间线，支持：
 * - 按时间排序的 checkpoint 列表
 * - Revert 按钮恢复至指定 checkpoint
 * - Compare diff 查看变更
 * - 手动清理按钮
 */
export function CheckpointControls({
  checkpoints,
  onRevert,
  onCompareDiff,
  onCleanup,
  className,
}: CheckpointControlsProps) {
  if (checkpoints.length === 0) {
    return (
      <div className={cn('text-sm text-vscode-fg/50 px-3 py-2', className)}>
        暂无快照
      </div>
    );
  }

  const sorted = [...checkpoints].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className={cn('rounded-lg border border-vscode-input-border overflow-hidden', className)}>
      <div className="flex items-center justify-between px-3 py-2 bg-vscode-sidebar-bg border-b border-vscode-input-border">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-vscode-fg/60" />
          <span className="text-sm font-medium text-vscode-fg">Checkpoints</span>
          <span className="text-xs text-vscode-fg/40">({checkpoints.length})</span>
        </div>
        {onCleanup && checkpoints.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onCleanup(sorted.slice(3).map((c) => c.id))}
          >
            <Trash2 className="h-3 w-3" />
            清理
          </Button>
        )}
      </div>
      <div className="max-h-48 overflow-y-auto">
        {sorted.map((cp, i) => (
          <div key={cp.id}>
            {i > 0 && <Separator />}
            <div className="flex items-center justify-between px-3 py-2 hover:bg-vscode-sidebar-bg/50">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-vscode-fg truncate">{cp.label}</div>
                <div className="text-xs text-vscode-fg/40">
                  {new Date(cp.timestamp).toLocaleString()} · {cp.files} 个文件
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {onCompareDiff && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onCompareDiff(cp.id)}
                  >
                    diff
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRevert(cp.id)}
                >
                  <RotateCcw className="h-3 w-3" />
                  回滚
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
