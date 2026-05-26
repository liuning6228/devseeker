import React, { useState } from 'react';
import { cn } from '../../lib/utils.js';

interface UnsafeImageProps {
  src: string;
  alt?: string;
  className?: string;
  maxWidth?: number;
}

/**
 * UnsafeImage — 安全图片渲染
 *
 * 对用户输入的图片 URL 做安全防护：
 * - onerror 兜底显示加载失败提示
 * - 对非 http/https/data 协议隐藏
 * - 用于渲染 Markdown 中的图片引用
 */
export function UnsafeImage({ src, alt, className, maxWidth = 600 }: UnsafeImageProps) {
  const [error, setError] = useState(false);

  // 安全检查：只允许 http/https/data 协议
  const isSafe = /^(https?:\/\/|data:image\/)/.test(src);
  if (!isSafe) {
    return (
      <span className="text-xs text-red-500">[不安全的图片链接]</span>
    );
  }

  if (error) {
    return (
      <span className="text-xs text-vscode-fg/50">[图片加载失败: {alt || src.slice(0, 40)}]</span>
    );
  }

  return (
    <img
      src={src}
      alt={alt || '图片'}
      onError={() => setError(true)}
      className={cn('rounded border border-vscode-input-border', className)}
      style={{ maxWidth: `${maxWidth}px`, maxHeight: '400px' }}
      loading="lazy"
    />
  );
}
