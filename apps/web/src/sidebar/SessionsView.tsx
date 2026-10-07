import { useEffect, useState } from 'react';
import type { AgentSessionInfo } from '@ide/shared';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { timeAgo } from '../format';

/** Danh sách phiên hội thoại Claude của thư mục làm việc: mở lại, đổi tên, xóa, tạo mới. */
export function SessionsView() {
  const { sessionsRev, info } = useWorkspace();
  const [sessions, setSessions] = useState<AgentSessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .sessions()
      .then((s) => alive && (setSessions(s), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [sessionsRev, info?.root, reload]);

  const fail = (e: Error) => setError(e.message);

  const commitRename = () => {
    if (!editing) return;
    const title = editing.title.trim();
    setEditing(null);
    if (title) api.renameSession(editing.id, title).catch(fail);
  };

  return (
    <div className="explorer">
      <div className="explorer-title">
        <span className="sidebar-title">Phiên Claude</span>
        <button className="icon-btn" title="Phiên mới" onClick={() => api.agentClear().catch(fail)}>
          <span className="codicon codicon-add" />
        </button>
        <button className="icon-btn" title="Làm mới" onClick={() => setReload((n) => n + 1)}>
          <span className="codicon codicon-refresh" />
        </button>
      </div>
      <div className="side-list">
        {error && <div className="sidebar-message is-error">{error}</div>}
        {!sessions && !error && <div className="side-count">Đang tải…</div>}
        {sessions?.length === 0 && <div className="side-count">Chưa có phiên nào. Nhắn cho Claude để bắt đầu.</div>}
        {sessions?.map((s) =>
          editing?.id === s.id ? (
            <div key={s.id} className="side-row session-row">
              <input
                autoFocus
                className="session-rename"
                value={editing.title}
                onChange={(e) => setEditing({ id: s.id, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditing(null);
                }}
                onBlur={commitRename}
                aria-label="Tên phiên"
              />
            </div>
          ) : (
            <div key={s.id} className={`side-row session-row ${s.current ? 'is-current' : ''}`} title={s.title}>
              <button className="side-row-main" onClick={() => !s.current && api.openSession(s.id).catch(fail)}>
                <span className={`codicon ${s.current ? 'codicon-comment-discussion' : 'codicon-comment'}`} />
                <span className="side-row-name">{s.title}</span>
                <span className="side-row-dir">{timeAgo(s.lastModified)}</span>
              </button>
              <span className="row-actions">
                <button className="icon-btn" title="Đổi tên" onClick={() => setEditing({ id: s.id, title: s.title })}>
                  <span className="codicon codicon-edit" />
                </button>
                <button
                  className="icon-btn"
                  title="Xóa phiên"
                  onClick={() => window.confirm(`Xóa phiên "${s.title}"? Không khôi phục được.`) && api.deleteSession(s.id).catch(fail)}
                >
                  <span className="codicon codicon-trash" />
                </button>
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
