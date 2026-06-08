import { useState, useMemo } from 'react';
import type { SessionSummary } from '../protocol';

export interface SessionDrawerProps {
  sessions: SessionSummary[];
  currentSessionId?: string;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  /** Step 13: 批量删除 */
  onDeleteMultiple?: (ids: string[]) => void;
  /** Step 13: 更新标签 */
  onUpdateTags?: (sessionId: string, tags: string[]) => void;
  /** Step 13: 用于 postMessage 的类型传递 */
  postToHost?: (msg: any) => void;
}

export function SessionDrawer({
  sessions,
  currentSessionId,
  onLoad,
  onDelete,
  onDeleteMultiple,
  postToHost,
}: SessionDrawerProps): JSX.Element | null {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'date' | 'title' | 'count'>('date');
  // Step 13: 批量选择
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Step 13: 删除确认
  const [deleteConfirmIds, setDeleteConfirmIds] = useState<string[] | null>(null);

  // Step 13: 从 sessions 提取所有标签
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    sessions.forEach((s) => s.tags?.forEach((t) => tagSet.add(t)));
    return [...tagSet].sort();
  }, [sessions]);

  const [selectedTag, setSelectedTag] = useState<string>('all');

  const filteredSessions = useMemo(() => {
    let result = sessions;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((s) => s.title.toLowerCase().includes(q) || s.tags?.some((t) => t.includes(q)));
    }
    if (selectedTag !== 'all') {
      result = result.filter((s) => s.tags?.includes(selectedTag));
    }
    result.sort((a, b) => {
      if (sortBy === 'date') return b.updatedAt - a.updatedAt;
      if (sortBy === 'title') return a.title.localeCompare(b.title);
      if (sortBy === 'count') return b.messageCount - a.messageCount;
      return 0;
    });
    return result;
  }, [sessions, searchQuery, sortBy, selectedTag]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleBatchDelete = () => {
    if (selectedIds.size === 0) return;
    setDeleteConfirmIds([...selectedIds]);
  };

  const confirmBatchDelete = () => {
    if (deleteConfirmIds) {
      onDeleteMultiple?.(deleteConfirmIds);
      setSelectedIds(new Set());
      setDeleteConfirmIds(null);
    }
  };

  if (sessions.length === 0) return null;

  return (
    <aside className="session-drawer" aria-label="Sessions">
      <div className="session-drawer__header">
        <span>历史会话</span>
        <span className="session-drawer__count">{sessions.length}</span>
      </div>

      {/* Step 13: 搜索框 */}
      <div className="session-drawer__search">
        <input type="text" placeholder="搜索会话..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="session-drawer__search-input" />
      </div>

      {/* Step 13: 排序选项 */}
      <div className="session-drawer__sort-row">
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className="session-drawer__select">
          <option value="date">按时间</option>
          <option value="title">按标题</option>
          <option value="count">按消息数</option>
        </select>
        {allTags.length > 0 && (
          <select value={selectedTag} onChange={(e) => setSelectedTag(e.target.value)} className="session-drawer__select">
            <option value="all">全部标签</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      {/* Step 13: 批量操作栏 */}
      {selectedIds.size > 0 && (
        <div className="session-drawer__batch-bar">
          <span>已选 {selectedIds.size} 项</span>
          <button className="session-drawer__batch-btn session-drawer__batch-btn--delete" onClick={handleBatchDelete}>删除所选</button>
          <button className="session-drawer__batch-btn" onClick={() => setSelectedIds(new Set())}>取消选择</button>
        </div>
      )}

      <ul className="session-drawer__list">
        {filteredSessions.map((s) => {
          const active = s.id === currentSessionId;
          const selected = selectedIds.has(s.id);
          return (
            <li key={s.id} className={`session-drawer__item ${active ? 'session-drawer__item--active' : ''} ${selected ? 'session-drawer__item--selected' : ''}`}>
              {/* Step 13: 复选框 */}
              <input type="checkbox" className="session-drawer__checkbox" checked={selected} onChange={() => toggleSelect(s.id)} aria-label={`选择 ${s.title}`} />
              <button type="button" className="session-drawer__title" title={s.title} onClick={() => onLoad(s.id)}>
                <span className="session-drawer__text">{s.title || '(无标题)'}</span>
                <span className="session-drawer__meta">{s.messageCount} 条 · {formatTime(s.updatedAt)}</span>
                {s.tags && s.tags.length > 0 && (
                  <span className="session-drawer__tags">{s.tags.map((t) => <span key={t} className="session-drawer__tag">{t}</span>)}</span>
                )}
              </button>
              <button type="button" className="session-drawer__delete" aria-label={`删除 ${s.title}`} onClick={(e) => { e.stopPropagation(); setDeleteConfirmIds([s.id]); }}>×</button>
            </li>
          );
        })}
      </ul>

      {/* 删除确认对话框 */}
      {deleteConfirmIds && (
        <div className="session-drawer__confirm-overlay" onClick={() => setDeleteConfirmIds(null)}>
          <div className="session-drawer__confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="session-drawer__confirm-title">确认删除</div>
            <div className="session-drawer__confirm-desc">将永久删除 {deleteConfirmIds.length} 个会话，此操作不可撤销。</div>
            <div className="session-drawer__confirm-actions">
              <button className="btn btn-outline" onClick={() => setDeleteConfirmIds(null)}>取消</button>
              <button className="btn btn-primary" onClick={confirmBatchDelete}>确认删除</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
