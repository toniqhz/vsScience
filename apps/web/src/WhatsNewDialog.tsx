import { useEffect, useState } from 'react';
import { api } from './api/client';
import { useWorkspace } from './api/workspace';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { RELEASE_NOTES, notesBetween, type ReleaseNote } from './whatsNew';

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
  upcoming,
  onUpdate,
  onClose,
}: {
  from?: string | null;
  to?: string | null;
  /** Không biết bản dùng trước đó (cập nhật từ bản cũ chưa ghi nhớ): chỉ hiện phần mới của bản đang chạy. */
  fromUnknown?: boolean;
  /** Có bản mới chưa cài: hiện ghi chú của bản mới (tải từ GitHub) kèm nút cập nhật. */
  upcoming?: boolean;
  /** Mở hộp thoại cập nhật. */
  onUpdate?: () => void;
  onClose: () => void;
}) {
  const { update } = useWorkspace();
  const [remote, setRemote] = useState<{ notes: ReleaseNote[] | null; error?: string } | null>(upcoming ? { notes: null } : null);
  useEffect(() => {
    if (!upcoming) return;
    api.updateNotes().then(
      (notes) => setRemote({ notes }),
      (e: Error) => setRemote({ notes: [], error: e.message }),
    );
  }, [upcoming]);
  const notes = upcoming
    ? (remote?.notes ?? [])
    : (from && to ? notesBetween(from, to) : (to ? notesBetween('0', to) : RELEASE_NOTES)).slice(0, upcoming ? 99 : 4);
  const latest = upcoming ? update?.latest : (to ?? notes[0]?.version);

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
            <div className="whats-new-title">
              {upcoming ? `Có bản mới VsScience ${latest ?? ''}` : from ? `Đã cập nhật lên VsScience ${latest}` : 'Có gì mới trong VsScience'}
            </div>
            <div className="whats-new-sub">
              {upcoming
                ? `Những gì mới so với bản ${update?.current ?? ''} bạn đang dùng`
                : fromUnknown
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
          {upcoming && !remote?.notes && <div className="whats-new-empty">Đang tải ghi chú bản mới…</div>}
          {remote?.error && <div className="whats-new-empty">{remote.error}</div>}
          {notes.length === 0 && (!upcoming || (remote?.notes && !remote.error)) && <div className="whats-new-empty">Chưa có ghi chú cho bản này.</div>}
        </div>
        <div className="modal-footer">
          <span className="modal-footer-path" />
          {upcoming && onUpdate ? (
            <>
              <button className="btn" onClick={onClose}>
                Để sau
              </button>
              <button className="btn btn-primary" onClick={onUpdate}>
                <span className="codicon codicon-cloud-download" /> {update?.state === 'ready' ? 'Khởi động lại để cập nhật' : `Cập nhật lên ${latest ?? 'bản mới'}`}
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={onClose}>
              Đã hiểu
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
