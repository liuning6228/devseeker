import React, { useState, useMemo } from 'react';
import { Search, Trash2, Download, Clock, MessageSquare } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { ViewHeader } from '../common/ViewHeader.js';
import { DebouncedTextField } from '../common/DebouncedTextField.js';
import { Button } from '../ui/button.js';
import { AlertDialog } from '../common/AlertDialog.js';

interface HistoryItem {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

interface HistoryViewProps {
  sessions: HistoryItem[];
  onLoadSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onExportSession?: (id: string, format: 'md' | 'json') => void;
  onBack?: () => void;
  className?: string;
}

/**
 * HistoryView — 历史会话列表
 *
 * 支持：
 * - fuse.js 模糊搜索标题
 * - 加载 / 删除 / 导出
 * - 按时间排序
 */
export function HistoryView({
  sessions,
  onLoadSession,
  onDeleteSession,
  onExportSession,
  onBack,
  className,
}: HistoryViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, searchQuery]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [filtered]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;
    return d.toLocaleDateString();
  };

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <ViewHeader title="历史会话" onBack={onBack} />

      {/* 会话总数提示 */}
      {sessions.length > 0 && (
        <div className="px-4 py-2 text-xs text-vscode-fg/50 border-b border-vscode-input-border">
          共 {sessions.length} 个会话
        </div>
      )}

      {/* 搜索框 */}
      <div className="px-4 py-3 border-b border-vscode-input-border">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-vscode-fg/40" />
          <DebouncedTextField
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="搜索会话标题..."
            debounceMs={300}
            className="pl-9"
          />
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-vscode-fg/50">
            {searchQuery ? '未找到匹配的会话' : '暂无历史会话'}
          </div>
        ) : (
          <div className="divide-y divide-vscode-input-border">
            {sorted.map((session) => (
              <div
                key={session.id}
                className="flex items-center gap-3 px-4 py-3 hover:bg-vscode-sidebar-bg/50 group"
              >
                <button
                  onClick={() => onLoadSession(session.id)}
                  className="flex-1 min-w-0 text-left cursor-pointer"
                >
                  <div className="text-sm text-vscode-fg truncate">{session.title}</div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-vscode-fg/50">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatTime(session.updatedAt)}
                    </span>
                    <span className="flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      {session.messageCount}
                    </span>
                  </div>
                </button>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {onExportSession && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onExportSession(session.id, 'md')}
                      title="导出为 Markdown"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeleteConfirmId(session.id)}
                    title="删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 删除确认弹窗 */}
      <AlertDialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => !open && setDeleteConfirmId(null)}
        title="删除会话"
        description="此操作不可撤销，确认删除该会话？"
        confirmLabel="删除"
        destructive
        onConfirm={() => {
          if (deleteConfirmId) {
            onDeleteSession(deleteConfirmId);
            setDeleteConfirmId(null);
          }
        }}
      />
    </div>
  );
}
