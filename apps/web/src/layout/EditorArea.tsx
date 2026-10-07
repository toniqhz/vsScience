import { useEffect, useState } from 'react';
import { DockviewReact, themeDark, type DockviewApi, type IDockviewPanelProps } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import type { FileDiff, FileKind } from '@ide/shared';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { DiffView } from '../chat/Transcript';
import { FILE_KIND_META, baseName } from '../fileTypes';
import { STATUS_META } from '../sidebar/ChangesView';
import { ExcelViewer } from '../viewers/ExcelViewer';
import { PdfViewer } from '../viewers/PdfViewer';
import { WordViewer } from '../viewers/WordViewer';
import { useWorkbench } from '../workbenchContext';

export type FilePanelParams = { path: string; kind: FileKind };
export type DiffPanelParams = { path: string };

function FilePanel({ params }: IDockviewPanelProps<FilePanelParams>) {
  if (params.kind === 'pdf') return <PdfViewer path={params.path} />;
  if (params.kind === 'excel') return <ExcelViewer path={params.path} />;
  if (/\.docx$/i.test(params.path)) return <WordViewer path={params.path} />;
  return (
    <div className="placeholder-panel">
      <span className={`codicon ${FILE_KIND_META[params.kind].icon} placeholder-icon kind-${params.kind}`} />
      <p>Chưa xem được file {FILE_KIND_META[params.kind].label} đời cũ (.doc). Hãy lưu lại thành .docx.</p>
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

/** Tab so sánh một file với bản lưu gần nhất (mở từ mục Thay đổi). */
function DiffPanel({ params }: IDockviewPanelProps<DiffPanelParams>) {
  const { changesRev } = useWorkspace();
  const { openPath } = useWorkbench();
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .changeDiff(params.path)
      .then((d) => alive && (setDiff(d), setError(null)))
      .catch((e: Error) => alive && (setDiff(null), setError(e.message)));
    return () => {
      alive = false;
    };
  }, [params.path, changesRev]);

  const restore = () => {
    if (!diff) return;
    const what = diff.status === 'added' ? 'Xóa file mới này?' : 'Hoàn tác mọi thay đổi của file này về bản lưu gần nhất?';
    if (window.confirm(`${what}\nThao tác này không quay lại được.`)) api.restoreFile(params.path).catch((e: Error) => setError(e.message));
  };

  return (
    <div className="diff-panel">
      <div className="viewer-toolbar">
        <span className="diff-panel-title">
          <strong>{baseName(params.path)}</strong>
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
            <button className="btn" onClick={() => openPath(params.path)}>
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
