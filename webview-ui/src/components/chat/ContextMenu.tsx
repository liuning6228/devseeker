import React, { useState, useCallback, useEffect } from 'react';
import Fuse from 'fuse.js';
import { FileText, Search, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface FileItem {
  path: string;
  displayName: string;
}

interface SearchResultItem {
  type: 'file' | 'symbol';
  label: string;
  description: string;
  onSelect: () => void;
}

interface ContextMenuProps {
  /** 搜索查询词 */
  query: string;
  /** 文件列表（来自工作区） */
  files: FileItem[];
  /** 符号列表（来自 codebaseIndex，可选） */
  symbols?: Array<{ name: string; filePath: string }>;
  /** 选中条目时回调 */
  onSelect: (item: SearchResultItem) => void;
  /** 关闭菜单 */
  onClose: () => void;
  /** 菜单是否可见 */
  isOpen: boolean;
  /** 触发位置 */
  triggerRect?: DOMRect;
  className?: string;
}

/**
 * ContextMenu — @ 文件引用弹出菜单
 *
 * 在 Composer 中检测到用户输入 @ 时弹出，
 * 使用 fuse.js 对文件名和符号名做模糊搜索。
 */
export function ContextMenu({
  query,
  files,
  symbols = [],
  onSelect,
  onClose,
  isOpen,
  triggerRect,
  className,
}: ContextMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // fuse.js 模糊搜索
  const fuse = new Fuse(files, {
    keys: ['path', 'displayName'],
    threshold: 0.4,
    minMatchCharLength: 1,
  });

  const results: SearchResultItem[] = [];

  // 文件名匹配
  const fileResults = query
    ? fuse.search(query).slice(0, 8).map((r) => ({
        type: 'file' as const,
        label: r.item.displayName,
        description: r.item.path,
        onSelect: () => onSelect({ type: 'file', label: r.item.displayName, description: r.item.path, onSelect: () => {} }),
      }))
    : files.slice(0, 8).map((f) => ({
        type: 'file' as const,
        label: f.displayName,
        description: f.path,
        onSelect: () => onSelect({ type: 'file', label: f.displayName, description: f.path, onSelect: () => {} }),
      }));

  results.push(...fileResults);

  // 符号名匹配
  if (query) {
    const symbolFuse = new Fuse(symbols, {
      keys: ['name', 'filePath'],
      threshold: 0.3,
    });
    const symbolResults = symbolFuse.search(query).slice(0, 4).map((r) => ({
      type: 'symbol' as const,
      label: r.item.name,
      description: r.item.filePath,
      onSelect: () => onSelect({ type: 'symbol', label: r.item.name, description: r.item.filePath, onSelect: () => {} }),
    }));
    results.push(...symbolResults);
  }

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      results[selectedIndex].onSelect();
      onClose();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [isOpen, results, selectedIndex, onSelect, onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!isOpen || results.length === 0) return null;

  const top = triggerRect ? triggerRect.bottom + 4 : '100%';

  return (
    <div
      className={cn(
        'absolute z-50 min-w-[250px] max-h-60 rounded-lg border border-vscode-input-border',
        'bg-vscode-bg shadow-lg overflow-y-auto',
        className,
      )}
      style={{ top }}
    >
      <div className="p-1 space-y-0.5">
        {results.map((item, i) => (
          <button
            key={`${item.type}-${item.label}-${i}`}
            onMouseDown={(e) => {
              e.preventDefault();
              item.onSelect();
              onClose();
            }}
            onMouseEnter={() => setSelectedIndex(i)}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 text-sm rounded cursor-pointer text-left',
              i === selectedIndex
                ? 'bg-vscode-sidebar-bg text-vscode-fg'
                : 'text-vscode-fg/80 hover:bg-vscode-sidebar-bg/50',
            )}
          >
            <span className="text-vscode-fg/50 shrink-0">
              {item.type === 'symbol' ? <Search className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{item.label}</div>
              <div className="text-xs text-vscode-fg/40 truncate">{item.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
