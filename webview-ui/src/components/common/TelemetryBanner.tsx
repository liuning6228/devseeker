import React, { useState } from 'react';
import { BarChart3, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';

interface TelemetryBannerProps {
  /** 同意回调 */
  onAccept: () => void;
  /** 拒绝回调 */
  onDecline: () => void;
  className?: string;
}

const TELEMETRY_DISMISSED_KEY = 'devSeeker.telemetry_dismissed';

/**
 * TelemetryBanner — 遥测同意/拒绝横幅
 *
 * 首次启动时展示，用户选择后通过 localStorage 持久化。
 */
export function TelemetryBanner({ onAccept, onDecline, className }: TelemetryBannerProps) {
  const [dismissed, setDismissed] = useState(() => {
    return !!localStorage.getItem(TELEMETRY_DISMISSED_KEY);
  });

  if (dismissed) return null;

  const handleAccept = () => {
    localStorage.setItem(TELEMETRY_DISMISSED_KEY, 'accepted');
    setDismissed(true);
    onAccept();
  };

  const handleDecline = () => {
    localStorage.setItem(TELEMETRY_DISMISSED_KEY, 'declined');
    setDismissed(true);
    onDecline();
  };

  return (
    <div className={cn(
      'flex items-start gap-3 p-3 rounded-lg border border-vscode-input-border bg-vscode-sidebar-bg',
      'animate-in fade-in slide-in-from-bottom-2',
      className,
    )}>
      <BarChart3 className="h-5 w-5 text-vscode-btn-bg mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-vscode-fg">帮助改进 DevSeeker</div>
        <div className="text-xs text-vscode-fg/60 mt-1">
          发送匿名使用数据帮助我们改善产品体验。
          不会收集代码内容或个人信息。
        </div>
        <div className="flex gap-2 mt-2">
          <Button size="sm" onClick={handleAccept}>
            同意并发送
          </Button>
          <Button size="sm" variant="outline" onClick={handleDecline}>
            拒绝
          </Button>
        </div>
      </div>
      <button
        onClick={handleDecline}
        className="p-0.5 rounded text-vscode-fg/40 hover:text-vscode-fg cursor-pointer shrink-0"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
