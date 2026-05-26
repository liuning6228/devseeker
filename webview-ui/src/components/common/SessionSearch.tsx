import React, { useState, useMemo, useRef, useEffect } from 'react';
import Fuse from 'fuse.js';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface SessionSearchProps {
  /** 历史会话列表 */
  sessions: Array<{ id: string; title: string; messages: string[] }>;
  /** 选中某条消息的回调 */
  onSelectMessage?: (sessionId: string, messageIndex: number) => void;
  className?: string;
}

/**
 * SessionSearch — 跨会话消息搜索
 *
 * 在 History 页面顶部提供搜索框。
 * 使用 fuse.js 对会话标题 + 消息内容做模糊搜索。
 * 结果分两组：匹配的会话标题 → 匹配的消息片段
 */
export function SessionSearch({ sessions, onSelectMessage, className }: SessionSearchProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // fuse.js 搜索
  const results = useMemo(() => {
    if (!query.trim()) return [];
    const fuse = new Fuse(sessions, {
      keys: [
        { name: 'title', weight: 2 },
        { name: 'messages', weight: 1 },
      ],
      threshold: 0.4,
      minMatchCharLength: 1,
    });
    return fuse.search(query).slice(0, 10);
  }, [sessions, query]);

  // 高亮匹配文本
  const highlightText = (text: string, highlight: string) => {
    if (!highlight.trim()) return text;
    const regex = new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part)
        ? <mark key={i} className="bg-yellow-500/30 text-vscode-fg rounded-sm">{part}</mark>
        : part,
    );
  };

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  // 键盘导航
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Escape') {
      setQuery('');
    }
  };

  return (
    <div className={cn('relative', className)}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-vscode-fg/40" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="搜索历史会话..."
          className="w-full pl-9 pr-8 py-2 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border
                     focus:outline-none focus:ring-2 focus:ring-vscode-focus placeholder:text-vscode-fg/40"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-vscode-fg/40 hover:text-vscode-fg cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* 搜索结果 */}
      {query && results.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 rounded-lg border border-vscode-input-border bg-vscode-bg shadow-lg max-h-60 overflow-y-auto">
          {results.map((result, i) => (
            <button
              key={result.item.id}
              onClick={() => onSelectMessage?.(result.item.id, 0)}
              onMouseEnter={() => setSelectedIndex(i)}
              className={cn(
                'w-full px-3 py-2 text-left cursor-pointer',
                i === selectedIndex ? 'bg-vscode-sidebar-bg' : 'hover:bg-vscode-sidebar-bg/50',
              )}
            >
              <div className="text-sm text-vscode-fg truncate">
                {highlightText(result.item.title, query)}
              </div>
              {result.matches?.slice(0, 2).map((match, j) => (
                <div key={j} className="text-xs text-vscode-fg/50 truncate mt-0.5">
                  ...{highlightText(match.value || '', query)}...
                </div>
              ))}
            </button>
          ))}
        </div>
      )}

      {query && results.length === 0 && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 px-3 py-2 text-sm text-vscode-fg/50 bg-vscode-bg border border-vscode-input-border rounded-lg">
          未找到匹配的会话
        </div>
      )}
    </div>
  );
}
