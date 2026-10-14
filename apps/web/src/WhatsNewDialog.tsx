import { useEffect } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { RELEASE_NOTES, notesBetween } from './whatsNew';

/** Ngày "2026-10-15" → "15/10/2026". */
function viDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
}

/**
 * Trang "Có gì mới": sau khi cập nhật, các tính năng mới từ bản người dùng dùng trước đó (`from`) tới bản
 * đang chạy (`to`). Mở từ menu Cài đặt (không có `from`) thì hiện vài bản gần nhất.
 */
export function WhatsNewDialog({
  from,
  to,
  fromUnknown,
  onClose,
}: {
  from?: string | null;
  to?: string | null;
  /** Không biết bản dùng trước đó (cập nhật từ bản cũ chưa ghi nhớ): chỉ hiện phần mới của bản đang chạy. */
  fromUnknown?: boolean;
  onClose: () => void;
}) {
  const notes = from && to ? notesBetween(from, to) : (to ? notesBetween('0', to) : RELEASE_NOTES).slice(0, 4);
  const latest = to ?? notes[0]?.version;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal whats-new" role="dialog" aria-label="Có gì mới">
        <div className="whats-new-hero">
          <span className="codicon codicon-sparkle whats-new-icon" />
          <div>
            <div className="whats-new-title">{from ? `Đã cập nhật lên VsScience ${latest}` : 'Có gì mới trong VsScience'}</div>
            <div className="whats-new-sub">
              {fromUnknown
                ? 'Những gì mới trong bản này'
                : from
                  ? `Những gì mới kể từ bản ${from} bạn dùng trước đó`
                  : `Các bản cập nhật gần đây${latest ? ` · đang dùng ${latest}` : ''}`}
            </div>
          </div>
          <button className="icon-btn" title="Đóng (Esc)" onClick={onClose}>
            <span className="codicon codicon-close" />
          </button>
        </div>
        <div className="whats-new-body">
          {notes.map((n, i) => (
            <section key={n.version} className="whats-new-release">
              <div className="whats-new-version">
                <span className={`whats-new-tag ${i === 0 ? 'is-latest' : ''}`}>{n.version}</span>
                {n.date && <span className="whats-new-date">{viDate(n.date)}</span>}
              </div>
              <div className="msg-assistant whats-new-md">
                <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
                  {n.body}
                </Markdown>
              </div>
            </section>
          ))}
          {notes.length === 0 && <div className="whats-new-empty">Chưa có ghi chú cho bản này.</div>}
        </div>
        <div className="modal-footer">
          <span className="modal-footer-path" />
          <button className="btn btn-primary" onClick={onClose}>
            Đã hiểu
          </button>
        </div>
      </div>
    </div>
  );
}
