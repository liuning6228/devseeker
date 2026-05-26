import React from 'react';
import { AlertTriangle, DollarSign, KeyRound, Settings } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { useExtensionState } from '../../context/ExtensionStateContext.js';

interface SpendLimitErrorProps {
  /** 错误类型 */
  type: 'spend_limit' | 'insufficient_balance';
  /** Provider ID */
  providerId?: string;
  /** 每日限额重置剩余的毫秒数（可选） */
  resetInMs?: number;
  /** 切换 Key 回调 */
  onSwitchKey?: () => void;
  /** 修改 Provider 回调 */
  onEditProvider?: () => void;
  className?: string;
}

/**
 * SpendLimitError / CreditLimitError — 配额超限专用错误卡片
 *
 * 与普通 ErrorRow 不同，此卡片提供 CTA 操作按钮（切换 Key / 修改 Provider），
 * 让用户能直接恢复工作，而非只看错误消息。
 */
export function SpendLimitError({
  type,
  providerId,
  resetInMs,
  onSwitchKey,
  onEditProvider,
  className,
}: SpendLimitErrorProps) {
  const isBalance = type === 'insufficient_balance';

  return (
    <div className={cn(
      'rounded-lg border p-4',
      isBalance
        ? 'border-yellow-500/30 bg-yellow-500/5'
        : 'border-red-500/30 bg-red-500/5',
      className,
    )}>
      <div className="flex items-start gap-3">
        {isBalance
          ? <DollarSign className="h-5 w-5 text-yellow-500 mt-0.5 shrink-0" />
          : <AlertTriangle className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
        }
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-vscode-fg">
            {isBalance ? 'API 余额不足' : '已达消费限额'}
          </div>
          <div className="text-xs text-vscode-fg/60 mt-1">
            {providerId && <span className="font-mono">{providerId}</span>}
            {isBalance
              ? ' 当前 API Key 余额不足，任务已终止。'
              : ' 当前 API Key 已达到今日消费限额，任务已终止。'
            }
          </div>
          {resetInMs && !isBalance && (
            <div className="text-xs text-vscode-fg/40 mt-0.5">
              每日限额将于 {Math.ceil(resetInMs / 3600000)} 小时后重置
            </div>
          )}
        </div>
      </div>
      <div className="flex gap-2 mt-3 ml-8">
        {onSwitchKey && (
          <Button size="sm" variant="outline" onClick={onSwitchKey}>
            <KeyRound className="h-3 w-3" />
            切换 Key
          </Button>
        )}
        {onEditProvider && (
          <Button size="sm" variant="outline" onClick={onEditProvider}>
            <Settings className="h-3 w-3" />
            修改 Provider
          </Button>
        )}
      </div>
    </div>
  );
}
