import { useEffect, useState } from 'react';
import { ARTIFACT_FOLDER, type ArtifactInfo } from '@ide/shared';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { timeAgo } from '../format';
import { FILE_KIND_META, kindOfPath } from '../fileTypes';

/**
 * Sản phẩm Claude tạo ra khi làm việc với thư mục này: file mới (ghi chú, bản tóm tắt, đề, bảng…) và trang
 * đăng lên claude.ai. Bấm để xem ở khung bên phải.
 */
export function ArtifactsView({ onOpen }: { onOpen: (a: ArtifactInfo) => void }) {
  const { artifactsRev, info } = useWorkspace();
  const [items, setItems] = useState<ArtifactInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .artifacts()
      .then((a) => alive && (setItems(a), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [artifactsRev, info?.root, reload]);

  return (
    <div className="explorer">
      <div className="explorer-title">
        <span className="sidebar-title">Artifact</span>
        <button className="icon-btn" title="Làm mới" onClick={() => setReload((n) => n + 1)}>
          <span className="codicon codicon-refresh" />
        </button>
      </div>
      <div className="side-list">
        {error && <div className="sidebar-message is-error">{error}</div>}
        {!items && !error && <div className="side-count">Đang tải…</div>}
        {items?.length === 0 && (
          <div className="side-count">
            Chưa có artifact nào. File Claude tạo ra trong thư mục này (ghi chú, bản tóm tắt, đề, bảng…) và trang Claude đăng lên claude.ai sẽ hiện ở đây.
          </div>
        )}
        {items?.map((a) => {
          const kind = a.source === 'file' && a.path ? kindOfPath(a.path) : null;
          const dir = a.path?.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/')) : '';
          return (
            <div key={a.id} className="side-row artifact-row" title={a.path ?? a.description ?? a.title}>
              <button className="side-row-main" onClick={() => onOpen(a)}>
                <span className={`codicon ${kind ? `${FILE_KIND_META[kind].icon} kind-${kind}` : a.kind === 'doc' ? 'codicon-book' : 'codicon-preview'}`} />
                <span className="artifact-text">
                  <span className="artifact-name">{a.title}</span>
                  {a.description && <span className="artifact-desc">{a.description}</span>}
                  <span className="artifact-time">
                    {a.source === 'file' ? dir || 'Thư mục gốc' : a.kind === 'doc' ? 'Claude Docs trên claude.ai' : 'Trang trên claude.ai'} · {timeAgo(a.updatedAt)}
                  </span>
                </span>
              </button>
              {/* File trong thư mục artifact/ luôn hiện theo thư mục: muốn bỏ thì xóa hoặc chuyển file đi. */}
              {!a.path?.startsWith(`${ARTIFACT_FOLDER}/`) && (
                <span className="row-actions">
                  <button
                  className="icon-btn"
                  title={a.source === 'file' ? 'Bỏ khỏi danh sách (file vẫn còn trong thư mục)' : 'Bỏ khỏi danh sách (trang trên claude.ai vẫn còn)'}
                  onClick={() =>
                    window.confirm(`Bỏ "${a.title}" khỏi danh sách? ${a.source === 'file' ? 'File vẫn còn trong thư mục.' : 'Trang trên claude.ai vẫn còn.'}`) &&
                    api.deleteArtifact(a.id).catch((e: Error) => setError(e.message))
                  }
                >
                  <span className="codicon codicon-trash" />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
