import { useEffect, useState } from 'react';
import { DockviewReact, themeDark, type DockviewApi, type IDockviewPanelProps } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import type { FileDiff, FileKind } from '@ide/shared';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { DiffView } from '../chat/Transcript';
import { FILE_KIND_META, baseName } from '../fileTypes';
import { STATUS_META, restoreSummary } from '../sidebar/ChangesView';
import { ExcelViewer } from '../viewers/ExcelViewer';
import { OpenExternalButton } from '../viewers/OpenExternalButton';
import { PdfViewer } from '../viewers/PdfViewer';
import { WordViewer } from '../viewers/WordViewer';
import { useWorkbench, type SnapshotRef } from '../workbenchContext';

export type FilePanelParams = { path: string; kind: FileKind };
export type DiffPanelParams = { path: string; snapshot?: SnapshotRef };

function FilePanel({ params }: IDockviewPanelProps<FilePanelParams>) {
  if (params.kind === 'pdf') return <PdfViewer path={params.path} />;
  if (params.kind === 'excel') return <ExcelViewer path={params.path} />;
  if (/\.docx$/i.test(params.path)) return <WordViewer path={params.path} />;
  return (
    <div className="placeholder-panel">
      <span className={`codicon ${FILE_KIND_META[params.kind].icon} placeholder-icon kind-${params.kind}`} />
      <p>Chưa xem trước được file Word đời cũ (.doc). Mở bằng Word để xem, sửa, hoặc lưu lại thành .docx.</p>
      <OpenExternalButton path={params.path} app="Word" primary />
    </div>
  );
}

function Watermark() {
  return (
    <div className="placeholder-panel">
      <span className="codicon codicon-book placeholder-icon" />
      <p>Chọn một file ở cột bên trái để mở.</p>
    </div>
  );
}

/**
 * Tab so sánh (mở từ mục Thay đổi). Không có `snapshot`: file hiện tại so với bản lưu gần nhất.
 * Có `snapshot`: file trong bản lưu đó so với bản ngay trước nó (giống xem một commit).
 */
function DiffPanel({ params }: IDockviewPanelProps<DiffPanelParams>) {
  if (params.snapshot) return <SnapshotDiffPanel path={params.path} snapshot={params.snapshot} />;
  return <WorkingDiffPanel path={params.path} />;
}

function SnapshotDiffPanel({ path, snapshot }: { path: string; snapshot: SnapshotRef }) {
  const { openPath } = useWorkbench();
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .snapshotDiff(snapshot.id, path)
      .then((d) => alive && (setDiff(d), setError(null)))
      .catch((e: Error) => alive && (setDiff(null), setError(e.message)));
    return () => {
      alive = false;
    };
  }, [path, snapshot.id]);

  const restore = () => {
    const what =
      diff?.status === 'deleted'
        ? `Trong bản "${snapshot.message}", file này đã bị xóa. Xóa file để giống bản đó?`
        : `Đưa file này về đúng như trong bản "${snapshot.message}"?`;
    if (!window.confirm(`${what}\nTrạng thái hiện tại được lưu thành một bản trước, nên bạn có thể quay lại.`)) return;
    api
      .restoreSnapshot(snapshot.id, path)
      .then((r) => setNotice(restoreSummary(r)))
      .catch((e: Error) => setError(e.message));
  };

  return (
    <div className="diff-panel">
      <div className="viewer-toolbar">
        <span className="diff-panel-title">
          <strong>{baseName(path)}</strong>
          {diff?.status && <span className={`status-tag status-${diff.status}`}>{STATUS_META[diff.status].label}</span>}
          {diff?.change && (
            <span className="change-stats">
              <span className="stat-add">+{diff.change.additions}</span>
              <span className="stat-del">−{diff.change.deletions}</span>
            </span>
          )}
          <span className="diff-snapshot" title={snapshot.message}>
            <span className="codicon codicon-git-commit" /> {snapshot.message}
          </span>
        </span>
        <span className="toolbar-group toolbar-search">
          <button className="icon-btn" title="Mở file hiện tại" onClick={() => openPath(path)}>
            <span className="codicon codicon-go-to-file" />
          </button>
          {diff?.status && (
            <button className="btn" title={`Đưa file về đúng như trong bản "${snapshot.message}"`} onClick={restore}>
              <span className="codicon codicon-discard" /> Khôi phục
            </button>
          )}
        </span>
      </div>
      <div className="diff-panel-body">
        {error && <div className="placeholder-panel">{error}</div>}
        {notice && <div className="diff-note">{notice}</div>}
        {diff?.note && <div className="diff-note">So với bản lưu ngay trước. {diff.note}</div>}
        {diff?.change && diff.change.hunks.length > 0 && <DiffView change={diff.change} />}
      </div>
    </div>
  );
}

function WorkingDiffPanel({ path }: { path: string }) {
  const { changesRev } = useWorkspace();
  const { openPath } = useWorkbench();
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .changeDiff(path)
      .then((d) => alive && (setDiff(d), setError(null)))
      .catch((e: Error) => alive && (setDiff(null), setError(e.message)));
    return () => {
      alive = false;
    };
  }, [path, changesRev]);

  const restore = () => {
    if (!diff) return;
    const what = diff.status === 'added' ? 'Xóa file mới này?' : 'Hoàn tác mọi thay đổi của file này về bản lưu gần nhất?';
    if (window.confirm(`${what}\nThao tác này không quay lại được.`)) api.restoreFile(path).catch((e: Error) => setError(e.message));
  };

  return (
    <div className="diff-panel">
      <div className="viewer-toolbar">
        <span className="diff-panel-title">
          <strong>{baseName(path)}</strong>
          {diff?.status && <span className={`status-tag status-${diff.status}`}>{STATUS_META[diff.status].label}</span>}
          {diff?.change && (
            <span className="change-stats">
              <span className="stat-add">+{diff.change.additions}</span>
              <span className="stat-del">−{diff.change.deletions}</span>
            </span>
          )}
        </span>
        <span className="toolbar-group toolbar-search">
          {diff?.status && diff.status !== 'deleted' && (
            <button className="btn" onClick={() => openPath(path)}>
              <span className="codicon codicon-go-to-file" /> Mở file
            </button>
          )}
          {diff?.status && (
            <button className="btn" onClick={restore}>
              <span className="codicon codicon-discard" /> Hoàn tác
            </button>
          )}
        </span>
      </div>
      <div className="diff-panel-body">
        {error && <div className="placeholder-panel">{error}</div>}
        {diff?.note && <div className="diff-note">{diff.note}</div>}
        {diff?.change && diff.change.hunks.length > 0 && <DiffView change={diff.change} />}
      </div>
    </div>
  );
}

const components = { file: FilePanel, diff: DiffPanel };

export function EditorArea({ onReady }: { onReady: (api: DockviewApi) => void }) {
  return (
    <DockviewReact
      className="editor-area"
      theme={themeDark}
      components={components}
      watermarkComponent={Watermark}
      disableFloatingGroups
      onReady={(e) => onReady(e.api)}
    />
  );
}
