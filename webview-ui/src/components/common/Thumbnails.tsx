import React, { useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface ThumbnailItem {
  /** base64 data URL 或 http URL */
  src: string;
  /** 可选的文件名 */
  name?: string;
}

interface ThumbnailsProps {
  images: ThumbnailItem[];
  onRemove?: (index: number) => void;
  className?: string;
  maxDisplay?: number;
}

/**
 * Thumbnails — 图片缩略图列表
 *
 * 用于 Composer 区域展示已粘贴的图片附件。
 * 支持：
 * - 网格缩略图展示
 * - 移除按钮
 * - 悬停放大（通过 lightbox 点击）
 */
export function Thumbnails({ images, onRemove, className, maxDisplay = 4 }: ThumbnailsProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const displayImages = images.slice(0, maxDisplay);
  const remaining = images.length - maxDisplay;

  return (
    <>
      <div className={cn('flex flex-wrap gap-2', className)}>
        {displayImages.map((img, i) => (
          <div key={i} className="relative group">
            <img
              src={img.src}
              alt={img.name || `图片 ${i + 1}`}
              className="h-16 w-16 object-cover rounded border border-vscode-input-border cursor-pointer"
              onClick={() => setLightboxIndex(i)}
            />
            {onRemove && (
              <button
                onClick={() => onRemove(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white
                           flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
        {remaining > 0 && (
          <div className="h-16 w-16 rounded border border-vscode-input-border flex items-center justify-center text-xs text-vscode-fg/50 bg-vscode-sidebar-bg">
            +{remaining}
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxIndex !== null && images[lightboxIndex] && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
          onClick={() => setLightboxIndex(null)}
        >
          <img
            src={images[lightboxIndex].src}
            alt={images[lightboxIndex].name || '大图预览'}
            className="max-w-[90vw] max-h-[90vh] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setLightboxIndex(null)}
            className="absolute top-4 right-4 text-white/80 hover:text-white cursor-pointer"
          >
            <X className="h-6 w-6" />
          </button>
        </div>
      )}
    </>
  );
}
