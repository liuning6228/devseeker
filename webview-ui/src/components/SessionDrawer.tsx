import type { SessionSummary } from '../protocol';

export interface SessionDrawerProps {
  sessions: SessionSummary[];
  currentSessionId?: string;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
}

export function SessionDrawer({
  sessions,
  currentSessionId,
  onLoad,
  onDelete,
}: SessionDrawerProps): JSX.Element | null {
  if (sessions.length === 0) return null;
  return (
    <aside className="session-drawer" aria-label="Sessions">
      <div className="session-drawer__header">历史会话</div>
      <ul className="session-drawer__list">
        {sessions.map((s) => {
          const active = s.id === currentSessionId;
          return (
            <li
              key={s.id}
              className={`session-drawer__item ${active ? 'session-drawer__item--active' : ''}`}
            >
              <button
                type="button"
                className="session-drawer__title"
                title={s.title}
                onClick={() => onLoad(s.id)}
              >
                <span className="session-drawer__text">{s.title || '(无标题)'}</span>
                <span className="session-drawer__meta">
                  {s.messageCount} 条 · {formatTime(s.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className="session-drawer__delete"
                aria-label={`删除 ${s.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(s.id);
                }}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
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
