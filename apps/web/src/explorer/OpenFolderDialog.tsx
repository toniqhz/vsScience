import { useEffect, useRef, useState } from 'react';
import type { DirListing } from '@ide/shared';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { IS_DESKTOP } from '../platform';

function lastSegment(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/**
 * Hộp thoại chọn thư mục làm việc. Trình duyệt không cho biết đường dẫn thật
 * trên máy, nên danh sách thư mục do server liệt kê.
 */
export function OpenFolderDialog({ onClose }: { onClose: () => void }) {
  const { info } = useWorkspace();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const browse = (path?: string) => {
    setError(null);
    api
      .listDirs(path)
      .then((l) => {
        setListing(l);
        setPathInput(l.path);
        listRef.current?.scrollTo({ top: 0 });
      })
      .catch((e: Error) => setError(e.message));
  };

  // Bắt đầu từ thư mục cha của thư mục đang mở, để thấy các thư mục "anh em".
  // Chỉ chạy một lần khi mở hộp thoại.
  useEffect(() => {
    browse(info?.root ? info.root.replace(/[\\/][^\\/]+$/, '') || undefined : undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = (path: string, newWindow = false) => {
    setBusy(true);
    setError(null);
    (newWindow ? api.openWindow(path) : api.openWorkspace(path))
      .then(onClose)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal open-folder" role="dialog" aria-label="Mở thư mục">
        <div className="modal-header">
          <span className="codicon codicon-folder-opened" />
          <span className="modal-title">Mở thư mục</span>
          <button className="icon-btn" title="Đóng (Esc)" onClick={onClose}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className="open-folder-body">
          <aside className="open-folder-side">
            <div className="side-section-title">Lối tắt</div>
            {listing?.shortcuts.map((s) => (
              <button key={s.path} className="side-item" title={s.path} onClick={() => browse(s.path)}>
                <span className="codicon codicon-folder" />
                <span className="side-item-label">{s.name}</span>
              </button>
            ))}
            {info && info.recent.length > 0 && (
              <>
                <div className="side-section-title">Mở gần đây</div>
                {info.recent.map((r) => (
                  <button key={r} className="side-item" title={`Mở ${r}`} onClick={() => open(r)} disabled={busy}>
                    <span className="codicon codicon-history" />
                    <span className="side-item-label">{lastSegment(r)}</span>
                  </button>
                ))}
              </>
            )}
          </aside>

          <section className="open-folder-main">
            <div className="path-bar">
              <button
                className="icon-btn"
                title="Lên thư mục cha"
                disabled={!listing?.parent}
                onClick={() => listing?.parent && browse(listing.parent)}
              >
                <span className="codicon codicon-arrow-up" />
              </button>
              <input
                className="path-input"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && browse(pathInput.trim())}
                spellCheck={false}
                aria-label="Đường dẫn thư mục"
              />
            </div>
            <div className="dir-list" ref={listRef}>
              {listing && listing.dirs.length === 0 && <div className="dir-empty">Không có thư mục con.</div>}
              {listing?.dirs.map((d) => (
                <button key={d.path} className="dir-item" onClick={() => browse(d.path)} title={d.path}>
                  <span className="codicon codicon-folder kind-folder" />
                  <span className="dir-name">{d.name}</span>
                  <span className="codicon codicon-chevron-right dir-chevron" />
                </button>
              ))}
            </div>
          </section>
        </div>

        {error && (
          <div className="modal-error">
            <span className="codicon codicon-error" /> {error}
          </div>
        )}

        <div className="modal-footer">
          <span className="modal-footer-path" title={listing?.path}>
            {listing ? `Sẽ mở: ${listing.path}` : 'Đang tải…'}
          </span>
          <button className="btn" onClick={onClose}>
            Hủy
          </button>
          {IS_DESKTOP && (
            <button
              className="btn"
              title="Mở thư mục trong một cửa sổ khác, cửa sổ này giữ nguyên (Ctrl+Shift+N)"
              disabled={!listing || busy}
              onClick={() => listing && open(listing.path, true)}
            >
              Mở trong cửa sổ mới
            </button>
          )}
          <button className="btn btn-primary" disabled={!listing || busy} onClick={() => listing && open(listing.path)}>
            Mở thư mục này
          </button>
        </div>
      </div>
    </div>
  );
}
