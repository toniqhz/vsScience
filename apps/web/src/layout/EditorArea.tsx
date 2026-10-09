import { useEffect, useState } from 'react';
import { DockviewReact, themeDark, type DockviewApi, type IDockviewPanelProps } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import type { FileDiff, FileKind } from '@ide/shared';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { DiffView } from '../chat/Transcript';
import { baseName } from '../fileTypes';
import { STATUS_META, restoreSummary } from '../sidebar/ChangesView';
import { ArtifactViewer } from '../viewers/ArtifactViewer';
import { ExcelViewer } from '../viewers/ExcelViewer';
import { OpenExternalButton } from '../viewers/OpenExternalButton';
import { ImageViewer } from '../viewers/ImageViewer';
import { PdfViewer } from '../viewers/PdfViewer';
import { PptxViewer } from '../viewers/PptxViewer';
import { TextViewer } from '../viewers/TextViewer';
import { WordViewer } from '../viewers/WordViewer';
import { useWorkbench, type SnapshotRef } from '../workbenchContext';

export type FilePanelParams = { path: string; kind: FileKind };
export type DiffPanelParams = { path: string; snapshot?: SnapshotRef };
export type ArtifactPanelParams = { artifactId: string; title: string; url: string | null; local: boolean; doc: boolean };

function ArtifactPanel({ params }: IDockviewPanelProps<ArtifactPanelParams>) {
  return <ArtifactViewer id={params.artifactId} title={params.title} url={params.url} local={params.local} doc={params.doc} />;
}

function FilePanel({ params }: IDockviewPanelProps<FilePanelParams>) {
  switch (params.kind) {
    case 'pdf':
      return <PdfViewer path={params.path} />;
    case 'excel':
      return <ExcelViewer path={params.path} />;
    case 'markdown':
    case 'text':
    case 'html':
      return <TextViewer path={params.path} kind={params.kind} />;
    case 'image':
      return <ImageViewer path={params.path} />;
    case 'powerpoint':
      if (/\.pptx$/i.test(params.path)) return <PptxViewer path={params.path} />;
      return (
        <div className="placeholder-panel">
          <span className="codicon codicon-preview placeholder-icon kind-powerpoint" />
          <p>Chưa xem trước được file PowerPoint đời cũ (.ppt). Mở bằng PowerPoint và lưu lại thành .pptx để xem trong app và để Claude đọc được.</p>
          <OpenExternalButton path={params.path} app="PowerPoint" primary />
        </div>
      );
    case 'word':
      if (/\.docx$/i.test(params.path)) return <WordViewer path={params.path} />;
      return (
        <div className="placeholder-panel">
          <span className="codicon codicon-file-text placeholder-icon kind-word" />
          <p>Chưa xem trước được file Word đời cũ (.doc). Mở bằng Word để xem, sửa, hoặc lưu lại thành .docx.</p>
          <OpenExternalButton path={params.path} app="Word" primary />
        </div>
      );
    default:
      // File khác (zip, video, âm thanh…): mở bằng ứng dụng trên máy. File chương trình/script thì không mở.
      return (
        <div className="placeholder-panel">
          <span className="codicon codicon-file placeholder-icon" />
          {EXECUTABLE.test(params.path) ? (
            <p>Đây là file chương trình hoặc script. App không mở loại file này vì mở tức là máy sẽ chạy nó.</p>
          ) : (
            <>
              <p>Chưa xem trước được loại file này trong app.</p>
              <OpenExternalButton path={params.path} app="ứng dụng mặc định" primary />
            </>
          )}
        </div>
      );
  }
}

/** Khớp danh sách file chạy được ở server (không mở bằng ứng dụng ngoài). */
const EXECUTABLE = /\.(exe|msi|bat|cmd|com|scr|pif|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|jar|py|pyw|sh|command|app|pkg|dmg|reg|cpl|url)$/i;

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

const components = { file: FilePanel, diff: DiffPanel, artifact: ArtifactPanel };

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
