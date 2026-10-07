import { useEffect, useRef, useState } from 'react';
import { Tree, type NodeRendererProps, type TreeApi } from 'react-arborist';
import type { TreeNode } from '@ide/shared';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { FILE_KIND_META } from '../fileTypes';
import { useElementSize } from '../useElementSize';
import { OpenFolderDialog } from './OpenFolderDialog';

const childrenOf = (n: TreeNode) => (n.type === 'folder' ? (n.children ?? []) : null);

type Creating = { type: 'file' | 'folder'; parent: string };

function parentDir(id: string): string {
  const i = id.lastIndexOf('/');
  return i < 0 ? '' : id.slice(0, i);
}

function Row({ node, style }: NodeRendererProps<TreeNode>) {
  const d = node.data;
  const isFolder = d.type === 'folder';
  const icon = isFolder
    ? node.isOpen
      ? 'codicon-folder-opened'
      : 'codicon-folder'
    : FILE_KIND_META[d.kind ?? 'pdf'].icon;
  return (
    <div
      style={style}
      className={`tree-row ${node.isSelected ? 'is-selected' : ''}`}
      title={d.id}
      // Row của arborist đã tự chọn và gọi onActivate khi bấm; ở đây chỉ cần mở/đóng thư mục.
      onClick={() => isFolder && node.toggle()}
    >
      <span className={`codicon ${isFolder ? (node.isOpen ? 'codicon-chevron-down' : 'codicon-chevron-right') : ''} tree-twistie`} />
      <span className={`codicon ${icon} tree-icon kind-${isFolder ? 'folder' : d.kind}`} />
      <span className="tree-label">{d.name}</span>
    </div>
  );
}

/** Ô nhập tên khi tạo file/thư mục mới, giống VS Code (Enter để tạo, Esc để hủy). */
function NewItemInput({
  creating,
  onDone,
  onCancel,
}: {
  creating: Creating;
  onDone: (path: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isFile = creating.type === 'file';

  const submit = () => {
    if (!name.trim()) return onCancel();
    setBusy(true);
    (isFile ? api.createFile(creating.parent, name) : api.createFolder(creating.parent, name))
      .then((r) => onDone(r.path))
      .catch((e: Error) => {
        setError(e.message);
        setBusy(false);
      });
  };

  return (
    <div className="new-item">
      {creating.parent && (
        <div className="new-item-where">
          trong <strong>{creating.parent}</strong>
        </div>
      )}
      <div className="new-item-row">
        <span className={`codicon ${isFile ? 'codicon-file-text kind-word' : 'codicon-folder kind-folder'}`} />
        <input
          autoFocus
          value={name}
          // readOnly thay vì disabled để không mất focus (Esc vẫn hủy được sau khi báo lỗi).
          readOnly={busy}
          placeholder={isFile ? 'Tên file (.docx hoặc .xlsx)' : 'Tên thư mục'}
          className={error ? 'has-error' : ''}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onCancel();
          }}
          onBlur={() => !busy && !error && onCancel()}
        />
      </div>
      {error && <div className="new-item-error">{error}</div>}
      {!error && isFile && <div className="new-item-hint">Không ghi đuôi thì tạo file Word.</div>}
    </div>
  );
}

export function Explorer({ onOpenFile }: { onOpenFile: (node: TreeNode) => void }) {
  const { info, tree, error, refresh } = useWorkspace();
  const treeRef = useRef<TreeApi<TreeNode> | null>(null);
  const [bodyRef, size] = useElementSize<HTMLDivElement>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState<Creating | null>(null);
  const pendingSelect = useRef<string | null>(null);
  const items = tree?.root.children ?? [];

  // Sau khi tạo xong, chọn mục mới khi cây đã tải lại.
  useEffect(() => {
    const id = pendingSelect.current;
    const t = treeRef.current;
    if (!id || !t?.get(id)) return;
    pendingSelect.current = null;
    t.openParents(id);
    t.select(id);
    t.scrollTo(id);
  }, [tree]);

  const startCreate = (type: Creating['type']) => {
    const sel = treeRef.current?.selectedNodes[0]?.data;
    const parent = !sel ? '' : sel.type === 'folder' ? sel.id : parentDir(sel.id);
    if (parent) treeRef.current?.open(parent);
    setCreating({ type, parent });
  };

  return (
    <div className="explorer">
      <div className="explorer-title">
        <span className="sidebar-title">Thư mục</span>
        <button className="icon-btn" title="Mở thư mục khác…" onClick={() => setDialogOpen(true)}>
          <span className="codicon codicon-folder-opened" />
        </button>
      </div>
      <div className="sidebar-header">
        <span className="codicon codicon-chevron-down section-chevron" />
        <span className="sidebar-title workspace-name" title={info?.root}>
          {info?.name ?? '…'}
        </span>
        <span className="header-actions">
          <button className="icon-btn" title="File mới (Word, Excel)" onClick={() => startCreate('file')}>
            <span className="codicon codicon-new-file" />
          </button>
          <button className="icon-btn" title="Thư mục mới" onClick={() => startCreate('folder')}>
            <span className="codicon codicon-new-folder" />
          </button>
          <button className="icon-btn" title="Làm mới" onClick={refresh}>
            <span className="codicon codicon-refresh" />
          </button>
          <button className="icon-btn" title="Thu gọn tất cả" onClick={() => treeRef.current?.closeAll()}>
            <span className="codicon codicon-collapse-all" />
          </button>
        </span>
      </div>
      {creating && (
        <NewItemInput
          key={`${creating.type}:${creating.parent}`}
          creating={creating}
          onCancel={() => setCreating(null)}
          onDone={(path) => {
            pendingSelect.current = path;
            setCreating(null);
            refresh();
          }}
        />
      )}
      <div className="sidebar-body" ref={bodyRef}>
        {error && <div className="sidebar-message is-error">{error}</div>}
        {!error && tree && items.length === 0 && (
          <div className="sidebar-message">
            <p>Thư mục chưa có file PDF, Word hay Excel nào.</p>
            <button className="btn btn-primary btn-block" onClick={() => setDialogOpen(true)}>
              Mở thư mục khác
            </button>
          </div>
        )}
        {tree?.truncated && <div className="sidebar-message">Thư mục quá lớn, chỉ hiện một phần.</div>}
        {size.height > 0 && items.length > 0 && (
          <Tree<TreeNode>
            ref={treeRef}
            data={items}
            idAccessor="id"
            childrenAccessor={childrenOf}
            openByDefault={false}
            width={size.width}
            height={size.height}
            rowHeight={22}
            indent={12}
            disableDrag
            disableDrop
            disableEdit
            disableMultiSelection
            onActivate={(node) => {
              if (node.data.type === 'file') onOpenFile(node.data);
            }}
          >
            {Row}
          </Tree>
        )}
      </div>
      {dialogOpen && <OpenFolderDialog onClose={() => setDialogOpen(false)} />}
    </div>
  );
}
