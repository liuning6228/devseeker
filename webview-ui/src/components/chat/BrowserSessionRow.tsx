import React, { useState, useCallback } from 'react';
import { Monitor, Maximize2, Minimize2, ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';

interface BrowserSessionRowProps {
  /** 当前页面截图（base64 data URL） */
  screenshot?: string;
  /** 当前 URL */
  url: string;
  /** 是否可以前进（浏览器会话历史） */
  canGoForward?: boolean;
  /** 是否可以后退 */
  canGoBack?: boolean;
  /** 截图时间戳 */
  timestamp?: number;
  /** 前进回调 */
  onGoForward?: () => void;
  /** 后退回调 */
  onGoBack?: () => void;
  /** 刷新回调 */
  onRefresh?: () => void;
  className?: string;
}

/**
 * BrowserSessionRow — 浏览器会话可视化行
 *
 * 在消息流中展示浏览器截图和导航控制。
 * 截图可缩放查看。
 */
export function BrowserSessionRow({
  screenshot,
  url,
  canGoForward,
  canGoBack,
  timestamp,
  onGoForward,
  onGoBack,
  onRefresh,
  className,
}: BrowserSessionRowProps) {
  const [zoomed, setZoomed] = useState(false);

  return (
    <div className={cn('rounded-lg border border-vscode-input-border overflow-hidden', className)}>
      {/* URL 地址栏 */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-vscode-sidebar-bg/50 border-b border-vscode-input-border">
        <Button
          variant="ghost"
          size="icon"
          onClick={onGoBack}
          disabled={!canGoBack}
          title="后退"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onGoForward}
          disabled={!canGoForward}
          title="前进"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onRefresh}
          title="刷新"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <div className="flex-1 flex items-center gap-1 px-2 py-0.5 rounded bg-vscode-input-bg text-xs font-mono text-vscode-fg/70 truncate mx-1">
          <Monitor className="h-3 w-3 shrink-0 text-vscode-fg/40" />
          <span className="truncate">{url}</span>
        </div>
        {screenshot && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setZoomed(!zoomed)}
            title={zoomed ? '缩小' : '放大'}
          >
            {zoomed ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>
        )}
      </div>

      {/* 截图区域 */}
      {screenshot && (
        <div className={cn(
          'bg-vscode-sidebar-bg/30',
          zoomed ? 'max-h-[80vh] overflow-auto' : 'max-h-[300px] overflow-hidden',
        )}>
          <img
            src={screenshot}
            alt={`浏览器截图: ${url}`}
            className={cn(
              'w-full object-contain cursor-pointer',
              zoomed ? 'h-auto' : 'h-[200px]',
            )}
            onClick={() => setZoomed(!zoomed)}
          />
        </div>
      )}

      {/* 时间戳 */}
      {timestamp && (
        <div className="px-3 py-1 text-[10px] text-vscode-fg/30 border-t border-vscode-input-border">
          截图时间：{new Date(timestamp).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
