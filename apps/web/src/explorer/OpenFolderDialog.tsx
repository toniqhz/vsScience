import { useEffect, useRef, useState } from 'react';
import type { CloudProviderId, CloudRemoteFolder, DirListing } from '@ide/shared';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { formatBytes, timeAgo } from '../format';
import { IS_DESKTOP } from '../platform';

function lastSegment(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/**
 * Hộp thoại chọn thư mục làm việc. Trình duyệt không cho biết đường dẫn thật
 * trên máy, nên danh sách thư mục do server liệt kê.
 */
export function OpenFolderDialog({ onClose }: { onClose: () => void }) {
  const { info, cloud } = useWorkspace();
  const [listing, setListing] = useState<DirListing | null>(null);
  /** Đang xem danh sách thư mục trên đám mây của một tài khoản. */
  const [remote, setRemote] = useState<{ provider: CloudProviderId; folders: CloudRemoteFolder[] | null } | null>(null);
  /** Thư mục trên đám mây đã chọn để tải về: đang chọn chỗ đặt trên máy. */
  const [cloneItem, setCloneItem] = useState<{ provider: CloudProviderId; name: string } | null>(null);
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

  const showRemote = (provider: CloudProviderId) => {
    setError(null);
    setCloneItem(null);
    setRemote({ provider, folders: null });
    api.cloudFolders(provider).then(
      (folders) => setRemote({ provider, folders }),
      (e: Error) => {
        setError(e.message);
        setRemote({ provider, folders: [] });
      },
    );
  };

  const connect = (provider: CloudProviderId) => {
    setError(null);
    api
      .cloudConnect(provider)
      .then(({ url }) => url && window.open(url, '_blank', 'noopener'))
      .catch((e: Error) => setError(e.message));
  };

  /** Tải thư mục đã chọn về thư mục đang xem rồi mở. */
  const clone = (newWindow = false) => {
    if (!cloneItem || !listing) return;
    setBusy(true);
    setError(null);
    api
      .cloudClone(cloneItem.provider, cloneItem.name, listing.path)
      .then(({ path }) => (newWindow ? api.openWindow(path) : api.openWorkspace(path)).then(() => undefined))
      .then(onClose)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const cloudProviders = (cloud?.providers ?? []).filter((p) => p.available);
  const cloneTarget = cloneItem && listing ? `${listing.path.replace(/[\\/]+$/, '')}${listing.path.includes('\\') ? '\\' : '/'}${cloneItem.name}` : '';

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
            {cloudProviders.length > 0 && (
              <>
                <div className="side-section-title">Trên đám mây</div>
                {cloudProviders.map((p) =>
                  p.account ? (
                    <button
                      key={p.id}
                      className={`side-item ${remote?.provider === p.id ? 'is-active' : ''}`}
                      title={`Các thư mục đã đồng bộ lên ${p.name} (${p.account.email ?? p.account.name})`}
                      onClick={() => showRemote(p.id)}
                    >
                      <span className="codicon codicon-cloud cloud-side-icon" />
                      <span className="side-item-label">{p.name}</span>
                    </button>
                  ) : (
                    <button key={p.id} className="side-item" title={`Đăng nhập ${p.name} để tải thư mục đã đồng bộ về máy này`} onClick={() => connect(p.id)}>
                      <span className={`codicon ${cloud?.connecting === p.id ? 'codicon-loading codicon-modifier-spin' : 'codicon-cloud'}`} />
                      <span className="side-item-label">Kết nối {p.name}</span>
                    </button>
                  ),
                )}
              </>
            )}
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

          {remote ? (
            <section className="open-folder-main">
              <div className="path-bar cloud-path-bar">
                <button className="icon-btn" title="Quay lại thư mục trên máy" onClick={() => setRemote(null)}>
                  <span className="codicon codicon-arrow-left" />
                </button>
                <span className="cloud-path-title">Thư mục đã đồng bộ lên {cloud?.providers.find((p) => p.id === remote.provider)?.name}</span>
              </div>
              <div className="dir-list">
                {!remote.folders && <div className="dir-empty">Đang tải danh sách…</div>}
                {remote.folders?.length === 0 && <div className="dir-empty">Chưa có thư mục nào được đồng bộ lên tài khoản này.</div>}
                {remote.folders?.map((f) => (
                  <button
                    key={f.name}
                    className="dir-item cloud-folder-item"
                    title={`Chọn chỗ đặt «${f.name}» trên máy này`}
                    onClick={() => {
                      setCloneItem({ provider: remote.provider, name: f.name });
                      setRemote(null);
                    }}
                  >
                    <span className="codicon codicon-cloud cloud-side-icon" />
                    <span className="dir-name">
                      {f.name}
                      <span className="cloud-folder-meta">
                        máy «{f.device}» · {timeAgo(f.updatedAt)} · {f.files} file · {formatBytes(f.bytes)}
                      </span>
                    </span>
                    <span className="codicon codicon-cloud-download dir-chevron" />
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <section className="open-folder-main">
              {cloneItem && (
                <div className="clone-banner">
                  <span className="codicon codicon-cloud-download" />
                  <span>
                    Chọn chỗ đặt thư mục «<b>{cloneItem.name}</b>» trên máy này, rồi bấm Tải về.
                  </span>
                  <button className="link-btn" onClick={() => setCloneItem(null)}>
                    Hủy
                  </button>
                </div>
              )}
              <div className="path-bar">
                <button className="icon-btn" title="Lên thư mục cha" disabled={!listing?.parent} onClick={() => listing?.parent && browse(listing.parent)}>
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
          )}
        </div>

        {error && (
          <div className="modal-error">
            <span className="codicon codicon-error" /> {error}
          </div>
        )}

        {remote ? (
          <div className="modal-footer">
            <span className="modal-footer-path">Chọn một thư mục để tải về máy này.</span>
            <button className="btn" onClick={onClose}>
              Hủy
            </button>
          </div>
        ) : cloneItem ? (
          <div className="modal-footer">
            <span className="modal-footer-path" title={cloneTarget}>
              {cloud?.clone ? `Đang tải về ${cloud.clone.done}/${cloud.clone.total}…` : `Sẽ tải về: ${cloneTarget}`}
            </span>
            <button className="btn" onClick={() => setCloneItem(null)} disabled={busy}>
              Hủy
            </button>
            {IS_DESKTOP && (
              <button className="btn" disabled={!listing || busy} onClick={() => clone(true)}>
                Tải về, mở ở cửa sổ mới
              </button>
            )}
            <button className="btn btn-primary" disabled={!listing || busy} onClick={() => clone(false)}>
              {busy ? <span className="codicon codicon-loading codicon-modifier-spin" /> : <span className="codicon codicon-cloud-download" />} Tải về và mở
            </button>
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
}
