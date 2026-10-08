import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Allotment, LayoutPriority } from 'allotment';
import 'allotment/dist/style.css';
import type { DockviewApi } from 'dockview-react';
import type { ArtifactInfo, ChangesResponse, TreeNode } from '@ide/shared';
import { api, hasToken } from './api/client';
import { WorkspaceProvider, useWorkspace } from './api/workspace';
import { Explorer } from './explorer/Explorer';
import { ChatPanel } from './layout/ChatPanel';
import { EditorArea, type ArtifactPanelParams, type DiffPanelParams, type FilePanelParams } from './layout/EditorArea';
import { baseName } from './fileTypes';
import { ArtifactsView } from './sidebar/ArtifactsView';
import { ChangesView } from './sidebar/ChangesView';
import { SearchView } from './sidebar/SearchView';
import { SessionsView } from './sidebar/SessionsView';
import { WorkbenchContext, type SnapshotRef } from './workbenchContext';

function findNode(node: TreeNode | undefined, id: string): TreeNode | undefined {
  if (!node) return undefined;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return undefined;
}

function countFiles(node: TreeNode | undefined): number {
  if (!node) return 0;
  if (node.type === 'file') return 1;
  return (node.children ?? []).reduce((n, c) => n + countFiles(c), 0);
}

type SideView = 'files' | 'search' | 'changes' | 'sessions' | 'artifacts';

const VIEWS: { id: SideView; icon: string; title: string }[] = [
  { id: 'files', icon: 'codicon-files', title: 'Thư mục' },
  { id: 'search', icon: 'codicon-search', title: 'Tìm kiếm' },
  { id: 'changes', icon: 'codicon-source-control', title: 'Thay đổi' },
  { id: 'sessions', icon: 'codicon-comment-discussion', title: 'Phiên Claude' },
  { id: 'artifacts', icon: 'codicon-preview', title: 'Artifact (trang Claude đã tạo)' },
];

function ActivityBar({
  view,
  sideOpen,
  onSelect,
  changeCount,
}: {
  view: SideView;
  sideOpen: boolean;
  onSelect: (v: SideView) => void;
  changeCount: number;
}) {
  return (
    <nav className="activity-bar">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          className={`activity-item ${sideOpen && view === v.id ? 'is-active' : ''}`}
          title={v.title}
          onClick={() => onSelect(v.id)}
        >
          <span className={`codicon ${v.icon}`} />
          {v.id === 'changes' && changeCount > 0 && <span className="activity-badge">{changeCount > 99 ? '99+' : changeCount}</span>}
        </button>
      ))}
      <div className="activity-spacer" />
      <button className="activity-item" title="Cài đặt (sắp có)" disabled>
        <span className="codicon codicon-settings-gear" />
      </button>
    </nav>
  );
}

function StatusBar({
  activePath,
  filesOpen,
  hasFiles,
  onToggleFiles,
}: {
  activePath: string | null;
  filesOpen: boolean;
  hasFiles: boolean;
  onToggleFiles: () => void;
}) {
  const { connected, tree } = useWorkspace();
  const fileCount = useMemo(() => countFiles(tree?.root), [tree]);
  return (
    <footer className={`status-bar ${connected ? '' : 'is-offline'}`}>
      <span className="status-item">
        <span className="codicon codicon-circle-filled status-dot" />
        {connected ? 'Đã kết nối' : 'Mất kết nối — đang thử lại…'}
      </span>
      <span className="status-item">{fileCount} file</span>
      <span className="status-spacer" />
      {activePath && <span className="status-item">{activePath}</span>}
      {hasFiles && (
        <button className="status-item status-btn" title={filesOpen ? 'Ẩn khung xem file' : 'Hiện khung xem file'} onClick={onToggleFiles}>
          <span className="codicon codicon-layout-sidebar-right" />
        </button>
      )}
    </footer>
  );
}

/** Danh sách file đã đổi so với bản lưu, tải lại khi file hoặc bản lưu đổi. */
function useChanges() {
  const { changesRev, info } = useWorkspace();
  const [data, setData] = useState<ChangesResponse | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    // Gom nhiều sự kiện file liên tiếp (Claude sửa nhiều file) thành một lần tải.
    const t = window.setTimeout(() => {
      api
        .changes()
        .then((d) => alive && setData(d))
        .catch(() => {});
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [changesRev, info?.root, reload]);
  return { data, refresh: () => setReload((n) => n + 1) };
}

/**
 * Bố cục: Claude ở giữa là khu vực làm việc chính; cột bên trái chuyển giữa
 * Thư mục / Tìm kiếm / Thay đổi / Phiên Claude; khung xem file ở bên phải.
 */
function Workbench() {
  const [view, setView] = useState<SideView>('files');
  const [sideOpen, setSideOpen] = useState(true);
  const [filesOpen, setFilesOpen] = useState(false);
  const [panelCount, setPanelCount] = useState(0);
  const [activePath, setActivePath] = useState<string | null>(null);
  const dockRef = useRef<DockviewApi | null>(null);
  const { info, tree } = useWorkspace();
  const changes = useChanges();

  // Đổi thư mục làm việc: đóng các tab của thư mục cũ.
  const root = info?.root;
  useEffect(() => {
    dockRef.current?.clear();
  }, [root]);

  const onDockReady = useCallback((api: DockviewApi) => {
    dockRef.current = api;
    api.onDidActivePanelChange(({ panel }) => {
      setActivePath((panel?.params as FilePanelParams | undefined)?.path ?? null);
    });
    api.onDidAddPanel(() => setPanelCount(api.panels.length));
    api.onDidRemovePanel(() => {
      setPanelCount(api.panels.length);
      if (api.panels.length === 0) setFilesOpen(false);
    });
  }, []);

  const openFile = useCallback((node: TreeNode) => {
    const api = dockRef.current;
    if (!api || node.type !== 'file' || !node.kind) return;
    setFilesOpen(true);
    const existing = api.getPanel(node.id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const params: FilePanelParams = { path: node.id, kind: node.kind };
    api.addPanel({ id: node.id, component: 'file', title: node.name, params });
  }, []);

  /** Mở file theo đường dẫn tương đối (từ thẻ thay đổi file, mục Thay đổi…). */
  const openPath = useCallback(
    (path: string) => {
      const node = findNode(tree?.root, path);
      if (node?.type === 'file') openFile(node);
    },
    [tree, openFile],
  );

  /** Mở tab so sánh file với bản lưu gần nhất. */
  const openDiff = useCallback((path: string, snapshot?: SnapshotRef) => {
    const api = dockRef.current;
    if (!api) return;
    setFilesOpen(true);
    const id = snapshot ? `diff:${snapshot.id}:${path}` : `diff:${path}`;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const params: DiffPanelParams = { path, snapshot };
    const title = snapshot ? `${baseName(path)} (${snapshot.message.length > 24 ? `${snapshot.message.slice(0, 24)}…` : snapshot.message})` : `${baseName(path)} (thay đổi)`;
    api.addPanel({ id, component: 'diff', title, params });
  }, []);

  /** Mở một artifact (trang Claude đã đăng) ở khung bên phải. */
  const openArtifact = useCallback((a: ArtifactInfo) => {
    // File trong thư mục: mở bằng khung xem file như khi bấm ở cây thư mục.
    if (a.source === 'file' && a.path) return openPath(a.path);
    const api = dockRef.current;
    if (!api) return;
    setFilesOpen(true);
    const id = `artifact:${a.id}`;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const params: ArtifactPanelParams = { artifactId: a.id, title: a.title, url: a.url };
    api.addPanel({ id, component: 'artifact', title: a.title, params });
  }, [openPath]);

  const actions = useMemo(() => ({ openPath, openDiff }), [openPath, openDiff]);

  // Bấm icon đang mở thì đóng cột bên trái (như VS Code).
  const selectView = (v: SideView) => {
    if (sideOpen && view === v) setSideOpen(false);
    else {
      setView(v);
      setSideOpen(true);
    }
  };

  const hasFiles = panelCount > 0;

  return (
    <WorkbenchContext.Provider value={actions}>
      <div className="workbench">
        <div className="workbench-main">
          <ActivityBar view={view} sideOpen={sideOpen} onSelect={selectView} changeCount={changes.data?.files.length ?? 0} />
          <Allotment proportionalLayout={false}>
            <Allotment.Pane preferredSize={260} minSize={180} maxSize={480} visible={sideOpen} snap>
              {/* Giữ các view luôn gắn để không mất trạng thái (cây đang mở, ô tìm kiếm) khi chuyển. */}
              <div className="side-views">
                <div className="side-view" hidden={view !== 'files'}>
                  <Explorer onOpenFile={openFile} />
                </div>
                <div className="side-view" hidden={view !== 'search'}>
                  {view === 'search' && <SearchView onOpenFile={openFile} />}
                </div>
                <div className="side-view" hidden={view !== 'changes'}>
                  <ChangesView data={changes.data} onRefresh={changes.refresh} />
                </div>
                <div className="side-view" hidden={view !== 'sessions'}>
                  {view === 'sessions' && <SessionsView />}
                </div>
                <div className="side-view" hidden={view !== 'artifacts'}>
                  {view === 'artifacts' && <ArtifactsView onOpen={openArtifact} />}
                </div>
              </div>
            </Allotment.Pane>
            <Allotment.Pane minSize={380} priority={LayoutPriority.High}>
              <ChatPanel activePath={filesOpen ? activePath : null} onOpenFile={openPath} />
            </Allotment.Pane>
            <Allotment.Pane preferredSize={560} minSize={320} visible={filesOpen && hasFiles}>
              <EditorArea onReady={onDockReady} />
            </Allotment.Pane>
          </Allotment>
        </div>
        <StatusBar activePath={activePath} filesOpen={filesOpen} hasFiles={hasFiles} onToggleFiles={() => setFilesOpen((o) => !o)} />
      </div>
    </WorkbenchContext.Provider>
  );
}

function MissingToken() {
  return (
    <div className="fullscreen-message">
      <span className="codicon codicon-warning placeholder-icon" />
      <h1>Chưa có mã truy cập</h1>
      <p>Hãy mở ứng dụng bằng đường link hiện trong cửa sổ máy chủ (có dạng …/?token=…).</p>
    </div>
  );
}

export function App() {
  const [ok] = useState(hasToken);
  if (!ok) return <MissingToken />;
  return (
    <WorkspaceProvider>
      <Workbench />
    </WorkspaceProvider>
  );
}
