import { memo, CSSProperties } from 'react';

interface SkeletonProps {
  variant?: 'text' | 'card' | 'circle' | 'rectangle' | 'message';
  width?: string | number;
  height?: string | number;
  animated?: boolean;
  lines?: number;
  className?: string;
}

/**
 * SkeletonScreen — 骨架屏组件
 * 在内容加载时显示占位动画，避免白屏闪烁。
 * 用法:
 *   <SkeletonScreen variant="message" />
 *   <SkeletonScreen variant="text" lines={3} />
 *   <SkeletonScreen variant="card" width={300} height={200} />
 */
export const SkeletonScreen = memo(function SkeletonScreen({
  variant = 'text', width, height, animated = true, lines = 1, className = '',
}: SkeletonProps) {
  const baseClass = `skeleton skeleton--${variant} ${animated ? 'skeleton--animated' : ''} ${className}`;
  const style: CSSProperties = {};
  if (width) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height) style.height = typeof height === 'number' ? `${height}px` : height;

  if (variant === 'text' && lines > 1) {
    return (
      <div className="skeleton-text-group" role="status" aria-label="加载中">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={baseClass} style={{ ...style, width: i === lines - 1 ? '60%' : '100%', height: height || '14px' }} />
        ))}
      </div>
    );
  }

  if (variant === 'circle') {
    return <div className={baseClass} style={{ ...style, width: width || '40px', height: height || '40px', borderRadius: '50%' }} role="status" aria-label="加载中" />;
  }

  if (variant === 'message') {
    return (
      <div className={baseClass} style={style} role="status" aria-label="消息加载中">
        <div className="skeleton-message">
          <div className="skeleton skeleton--circle" style={{ width: 28, height: 28 }} />
          <div className="skeleton-message__body">
            <div className="skeleton skeleton--text" style={{ width: '40%', height: 12 }} />
            <div className="skeleton skeleton--text" style={{ width: '100%', height: 12 }} />
            <div className="skeleton skeleton--text" style={{ width: '80%', height: 12 }} />
            <div className="skeleton skeleton--text" style={{ width: '55%', height: 12 }} />
          </div>
        </div>
      </div>
    );
  }

  return <div className={baseClass} style={style} role="status" aria-label="加载中" />;
});
