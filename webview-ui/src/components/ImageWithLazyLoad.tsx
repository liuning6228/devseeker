import { useState, useRef, useEffect, ImgHTMLAttributes } from 'react';

interface ImageWithLazyLoadProps extends ImgHTMLAttributes<HTMLImageElement> {
  placeholderBg?: string;
  onLoadError?: (error: string) => void;
}

/**
 * ImageWithLazyLoad — 图片懒加载组件
 * 使用 IntersectionObserver 延迟加载图片，减少初始渲染开销。
 */
export function ImageWithLazyLoad({
  src, alt = '', placeholderBg = 'var(--vscode-textBlockQuote-background, rgba(128,128,128,0.05))',
  className = '', onLoadError, ...imgProps
}: ImageWithLazyLoadProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inView, setInView] = useState(false);
  const imgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!imgRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setInView(true); observer.disconnect(); } },
      { rootMargin: '200px' }
    );
    observer.observe(imgRef.current);
    return () => observer.disconnect();
  }, []);

  const handleLoad = () => setLoaded(true);
  const handleError = () => { setError(`图片加载失败`); onLoadError?.(`图片加载失败: ${src}`); };

  return (
    <div ref={imgRef} className={`lazy-image ${className} ${loaded ? 'lazy-image--loaded' : ''} ${error ? 'lazy-image--error' : ''}`} style={{ background: placeholderBg }}>
      {inView && !error && (
        <img src={src} alt={alt} loading="lazy" onLoad={handleLoad} onError={handleError} className="lazy-image__img" {...imgProps} />
      )}
      {error && <div className="lazy-image__error"><span>🖼️</span><span>图片加载失败</span></div>}
    </div>
  );
}
