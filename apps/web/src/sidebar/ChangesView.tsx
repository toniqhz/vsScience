import { useEffect, useState } from 'react';
import type { ChangeStatus, ChangesResponse, RestoreResult, Snapshot, SnapshotDetail } from '@ide/shared';
import { api } from '../api/client';
import { baseName } from '../fileTypes';
import { dirName, timeAgo } from '../format';
import { useWorkbench } from '../workbenchContext';

export const STATUS_META: Record<ChangeStatus, { label: string; letter: string }> = {
  added: { label: 'Mới', letter: 'M' },
  modified: { label: 'Sửa', letter: 'S' },
  deleted: { label: 'Xóa', letter: 'X' },
};

function fileIcon(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'pdf') return 'codicon-file-pdf kind-pdf';
  if (ext === 'docx' || ext === 'doc') return 'codicon-file-text kind-word';
  if (['xlsx', 'xlsm', 'xls', 'csv'].includes(ext)) return 'codicon-table kind-excel';
  return 'codicon-file';
}

/**
 * Các file đã đổi so với bản lưu gần nhất (giống Source Control của VS Code, nhưng
 * không có khái niệm git): xem thay đổi, hoàn tác từng file, lưu thành bản mới.
 */
export function ChangesView({ data, onRefresh }: { data: ChangesResponse | null; onRefresh: () => void }) {
  const { openDiff, openPath } = useWorkbench();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const files = data?.files ?? [];

  const save = () => {
    setBusy(true);
    setError(null);
    api
      .saveSnapshot(message)
      .then(() => setMessage(''))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const restore = (path: string, status: ChangeStatus) => {
    const what =
      status === 'added'
        ? `Xóa file mới "${baseName(path)}"?`
        : `Hoàn tác mọi thay đổi của "${baseName(path)}" về bản lưu gần nhất?`;
    if (!window.confirm(`${what}\nThao tác này không quay lại được.`)) return;
    api.restoreFile(path).catch((e: Error) => setError(e.message));
  };

  return (
    <div className="explorer">
      <div className="explorer-title">
        <span className="sidebar-title">Thay đổi</span>
        <button className="icon-btn" title="Làm mới" onClick={onRefresh}>
          <span className="codicon codicon-refresh" />
        </button>
      </div>
      <div className="commit-box">
        <textarea
          rows={2}
          value={message}
          placeholder="Mô tả bản lưu (không bắt buộc)"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && files.length) save();
          }}
        />
        <button className="btn btn-primary btn-block" onClick={save} disabled={busy || files.length === 0}>
          <span className="codicon codicon-check" /> Lưu bản
        </button>
        {error && <div className="sidebar-message is-error">{error}</div>}
      </div>
      <div className="side-list">
        <div className="side-section">
          Thay đổi <span className="side-badge">{files.length}</span>
        </div>
        {!data && <div className="side-count">Đang tải…</div>}
        {data && files.length === 0 && <div className="side-count">Không có thay đổi nào so với bản lưu gần nhất.</div>}
        {files.map((f) => (
          <div key={f.path} className={`side-row change-row status-${f.status}`} title={`${f.path} — ${STATUS_META[f.status].label}`}>
            <button className="side-row-main" onClick={() => openDiff(f.path)}>
              <span className={`codicon ${fileIcon(f.path)}`} />
              <span className="side-row-name">{baseName(f.path)}</span>
              <span className="side-row-dir">{dirName(f.path)}</span>
            </button>
            <span className="row-actions">
              {f.status !== 'deleted' && (
                <button className="icon-btn" title="Mở file" onClick={() => openPath(f.path)}>
                  <span className="codicon codicon-go-to-file" />
                </button>
              )}
              <button className="icon-btn" title={f.status === 'added' ? 'Xóa file mới' : 'Hoàn tác thay đổi'} onClick={() => restore(f.path, f.status)}>
                <span className="codicon codicon-discard" />
              </button>
            </span>
            <span className="status-letter">{STATUS_META[f.status].letter}</span>
          </div>
        ))}

        <div className="side-section">Bản lưu gần đây</div>
        {notice && <div className="sidebar-message">{notice}</div>}
        {data?.snapshots.map((s, i) => (
          <SnapshotItem
            key={s.id}
            snapshot={s}
            isLatest={i === 0}
            onDone={(msg) => {
              setError(null);
              setNotice(msg);
            }}
            onError={setError}
          />
        ))}
      </div>
    </div>
  );
}

export function restoreSummary(r: RestoreResult): string {
  const parts = [r.restored && `khôi phục ${r.restored} file`, r.removed && `xóa ${r.removed} file`].filter(Boolean);
  if (!parts.length) return 'Các file đã đúng như bản này, không cần đổi gì.';
  return `Đã ${parts.join(', ')}. Muốn quay lại thì khôi phục về bản "${r.backup}".`;
}

/**
 * Một bản lưu trong lịch sử (giống một commit trong VS Code): bấm để xem các file đã đổi trong bản đó,
 * bấm file để xem thay đổi, khôi phục từng file hoặc cả thư mục về bản này.
 */
function SnapshotItem({
  snapshot: s,
  isLatest,
  onDone,
  onError,
}: {
  snapshot: Snapshot;
  isLatest: boolean;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const { openDiff } = useWorkbench();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<SnapshotDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || detail) return;
    let alive = true;
    api
      .snapshotDetail(s.id)
      .then((d) => alive && setDetail(d))
      .catch((e: Error) => alive && setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [open, detail, s.id]);

  const restoreAll = () => {
    const ok = window.confirm(
      `Khôi phục cả thư mục về bản "${s.message}"?\n\n` +
        'File Word, Excel, PDF sẽ trở lại đúng như lúc lưu bản này; file tạo sau đó sẽ bị xóa.\n' +
        'Trạng thái hiện tại được lưu thành một bản trước, nên bạn có thể quay lại.',
    );
    if (ok) api.restoreSnapshot(s.id).then((r) => onDone(restoreSummary(r)), (e: Error) => onError(e.message));
  };

  const restoreFile = (path: string, status: ChangeStatus) => {
    const what =
      status === 'deleted'
        ? `Trong bản "${s.message}", file "${baseName(path)}" đã bị xóa. Xóa file này để giống bản đó?`
        : `Đưa "${baseName(path)}" về đúng như trong bản "${s.message}"?`;
    if (window.confirm(`${what}\nTrạng thái hiện tại được lưu thành một bản trước, nên bạn có thể quay lại.`)) {
      api.restoreSnapshot(s.id, path).then((r) => onDone(restoreSummary(r)), (e: Error) => onError(e.message));
    }
  };

  const ref = { id: s.id, message: s.message };
  return (
    <>
      <div className="side-row snapshot-row" title={`${s.message}\n${new Date(s.time).toLocaleString('vi-VN')}`}>
        <button className="side-row-main" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className={`codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'} snapshot-chevron`} />
          <span className="codicon codicon-git-commit" />
          <span className="side-row-name">{s.message}</span>
          <span className="side-row-dir">{timeAgo(s.time)}</span>
        </button>
        <span className="row-actions">
          <button className="icon-btn" title={isLatest ? 'Khôi phục cả thư mục về bản lưu gần nhất' : 'Khôi phục cả thư mục về bản này'} onClick={restoreAll}>
            <span className="codicon codicon-discard" />
          </button>
        </span>
      </div>
      {open && (
        <div className="snapshot-files">
          {loadError && <div className="sidebar-message is-error">{loadError}</div>}
          {!detail && !loadError && <div className="side-count">Đang tải…</div>}
          {detail?.files.length === 0 && <div className="side-count">Bản này không đổi file nào.</div>}
          {detail?.files.map((f) => (
            <div key={f.path} className={`side-row change-row status-${f.status}`} title={`${f.path} — ${STATUS_META[f.status].label}`}>
              <button className="side-row-main" onClick={() => openDiff(f.path, ref)}>
                <span className={`codicon ${fileIcon(f.path)}`} />
                <span className="side-row-name">{baseName(f.path)}</span>
                <span className="side-row-dir">{dirName(f.path)}</span>
              </button>
              <span className="row-actions">
                <button
                  className="icon-btn"
                  title={f.status === 'deleted' ? 'Xóa file như trong bản này' : 'Đưa file về như trong bản này'}
                  onClick={() => restoreFile(f.path, f.status)}
                >
                  <span className="codicon codicon-discard" />
                </button>
              </span>
              <span className="status-letter">{STATUS_META[f.status].letter}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
