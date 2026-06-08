import { useState, useCallback, useEffect, useRef } from 'react';
import type { ContextSearchItem } from '../protocol';
import { getVsCodeApi } from '../vscode-api';

interface ContextPickerProps {
  query: string;
  onSelect: (item: ContextSearchItem) => void;
  onClose: () => void;
}

/** 搜索结果缓存：避免重复请求相同 query */
const searchCache = new Map<string, ContextSearchItem[]>();

/**
 * ContextPicker — @ 上下文选择器弹出面板
 *
 * 用户输入 @ 后弹出，按分类搜索文件/符号/记忆。
 * 文件搜索：首次返回全量文件名 → 前端 fuse.js 模糊匹配（减少 request 次数）
 * 符号搜索：用户切到"符号"Tab 时才触发（lazy fetch）
 */
export function ContextPicker({ query, onSelect, onClose }: ContextPickerProps) {
  const [items, setItems] = useState<ContextSearchItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [tab, setTab] = useState<'all' | 'file' | 'symbol' | 'memory'>('all');
  const queryRef = useRef(query);
  const pendingRef = useRef(false);
  const vscode = getVsCodeApi();

  // 实时搜索（防抖 100ms + 缓存）
  useEffect(() => {
    queryRef.current = query;
    const timer = setTimeout(() => {
      if (pendingRef.current) return;
      const q = queryRef.current;
      if (!q) { setItems([]); return; }
      const cacheKey = `${q}:${tab}`;
      const cached = searchCache.get(cacheKey);
      if (cached) {
        setItems(cached);
        setActiveIndex(0);
        return;
      }
      pendingRef.current = true;
      vscode.postMessage({ type: 'context_search', query: q, category: tab });
    }, 100);
    return () => clearTimeout(timer);
  }, [query, tab, vscode]);

  // 监听搜索结果
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      const msg = ev.data;
      if (msg?.type === 'context_search_result' && msg.query === queryRef.current) {
        pendingRef.current = false;
        setItems(msg.items || []);
        setActiveIndex(0);
        searchCache.set(`${msg.query}:${tab}`, msg.items);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [tab]);

  // 键盘导航
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && items[activeIndex]) { e.preventDefault(); onSelect(items[activeIndex]); }
    else if (e.key === 'Escape') { onClose(); }
  }, [items, activeIndex, onSelect, onClose]);

  if (!query) return null;

  const filtered = tab === 'all' ? items : items.filter((i) => i.type === tab);

  return (
    <div className="context-picker" onKeyDown={handleKeyDown} role="listbox" aria-label="上下文选择器">
      <div className="context-picker__tabs">
        {(['all', 'file', 'symbol', 'memory'] as const).map((t) => (
          <button key={t} className={`context-picker__tab ${tab === t ? 'is-active' : ''}`} onClick={() => setTab(t)}>
            {t === 'all' ? '全部' : t === 'file' ? '📄 文件' : t === 'symbol' ? '🔣 符号' : '🧠 记忆'}
          </button>
        ))}
      </div>
      <div className="context-picker__list">
        {filtered.length === 0 ? (
          <div className="context-picker__empty">{query ? '无匹配结果' : '输入关键词搜索'}</div>
        ) : (
          filtered.map((item, idx) => (
            <div key={item.id} className={`context-picker__item ${idx === activeIndex ? 'is-active' : ''}`}
              role="option" aria-selected={idx === activeIndex}
              onClick={() => onSelect(item)} onMouseEnter={() => setActiveIndex(idx)}>
              <span className="context-picker__item-icon">{item.type === 'file' ? '📄' : item.type === 'symbol' ? '🔣' : '🧠'}</span>
              <span className="context-picker__item-text">
                <span className="context-picker__item-name">{item.name}</span>
                <span className="context-picker__item-path">{item.path}</span>
              </span>
              {item.kind && <span className="context-picker__item-kind">{item.kind}</span>}
            </div>
          ))
        )}
      </div>
      <div className="context-picker__hint">↑↓ 导航 · Enter 选择 · Esc 关闭</div>
    </div>
  );
}
