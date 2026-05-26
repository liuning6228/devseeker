import React, { useState, useEffect, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface BannerItem {
  id: string;
  title: string;
  description: string;
  icon?: string;
}

interface BannerCarouselProps {
  banners: BannerItem[];
  onDismiss: (id: string) => void;
  dismissedIds?: Set<string>;
  className?: string;
  autoPlayInterval?: number;
}

/**
 * BannerCarousel — 公告轮播组件
 *
 * 用于 Welcome 页面展示更新公告/功能提示。
 * 支持：
 * - 多页轮播（自动播放 + 手动切换）
 * - Dismiss 持久化（通过 onDismiss + dismissedIds）
 * - 可关闭
 */
export function BannerCarousel({
  banners,
  onDismiss,
  dismissedIds = new Set(),
  className,
  autoPlayInterval = 5000,
}: BannerCarouselProps) {
  const visible = banners.filter((b) => !dismissedIds.has(b.id));
  const [currentIndex, setCurrentIndex] = useState(0);

  const goTo = useCallback((index: number) => {
    setCurrentIndex(index);
  }, []);

  const goNext = useCallback(() => {
    setCurrentIndex((prev) => (prev + 1) % visible.length);
  }, [visible.length]);

  const goPrev = useCallback(() => {
    setCurrentIndex((prev) => (prev - 1 + visible.length) % visible.length);
  }, [visible.length]);

  useEffect(() => {
    if (visible.length <= 1 || autoPlayInterval <= 0) return;
    const timer = setInterval(goNext, autoPlayInterval);
    return () => clearInterval(timer);
  }, [visible.length, autoPlayInterval, goNext]);

  if (visible.length === 0) return null;

  const current = visible[currentIndex];

  return (
    <div className={cn('relative rounded-lg border border-vscode-input-border bg-vscode-sidebar-bg/30 overflow-hidden', className)}>
      <div className="p-3 pr-8">
        <div className="flex items-start gap-2">
          {current.icon && <span className="text-lg">{current.icon}</span>}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-vscode-fg">{current.title}</div>
            <div className="text-xs text-vscode-fg/60 mt-0.5">{current.description}</div>
          </div>
        </div>
      </div>

      {/* 关闭按钮 */}
      <button
        onClick={() => onDismiss(current.id)}
        className="absolute top-2 right-2 p-0.5 rounded text-vscode-fg/40 hover:text-vscode-fg hover:bg-vscode-sidebar-bg cursor-pointer"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      {/* 导航指示器 */}
      {visible.length > 1 && (
        <div className="flex items-center justify-center gap-1 pb-2">
          <button onClick={goPrev} className="p-0.5 text-vscode-fg/40 hover:text-vscode-fg cursor-pointer">
            <ChevronLeft className="h-3 w-3" />
          </button>
          {visible.map((b, i) => (
            <button
              key={b.id}
              onClick={() => goTo(i)}
              className={cn(
                'w-1.5 h-1.5 rounded-full transition-colors cursor-pointer',
                i === currentIndex ? 'bg-vscode-btn-bg' : 'bg-vscode-input-border',
              )}
            />
          ))}
          <button onClick={goNext} className="p-0.5 text-vscode-fg/40 hover:text-vscode-fg cursor-pointer">
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
