import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FileKind } from '@ide/shared';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { FILE_KIND_META } from '../fileTypes';

/**
 * Xem file chữ Claude hay viết ra: ghi chú Markdown (hiển thị định dạng), .txt, trang HTML (chạy trong
 * khung cách ly như artifact). Markdown và HTML có nút xem dạng chữ gốc. Tự tải lại khi file đổi trên đĩa.
 */
export function TextViewer({ path, kind }: { path: string; kind: FileKind }) {
  const { onFileChange } = useWorkspace();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [source, setSource] = useState(false);

  useEffect(() => onFileChange(path, () => setReloadKey((k) => k + 1)), [path, onFileChange]);

  useEffect(() => {
    let alive = true;
    api.fileBytes(path).then(
      (data) => alive && (setText(new TextDecoder().decode(data)), setError(null)),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [path, reloadKey]);

  const meta = FILE_KIND_META[kind];
  const canToggle = kind === 'markdown' || kind === 'html';
  return (
    <div className="text-viewer">
      <div className="viewer-toolbar">
        <span className="toolbar-group viewer-info">
          <span className={`codicon ${meta.icon} kind-${kind}`} />
          {meta.label}
        </span>
        {canToggle && (
          <button className="btn text-viewer-toggle" onClick={() => setSource((v) => !v)}>
            <span className={`codicon ${source ? 'codicon-preview' : 'codicon-code'}`} /> {source ? 'Xem hiển thị' : 'Xem dạng chữ gốc'}
          </button>
        )}
      </div>
      {error && <div className="placeholder-panel">{error}</div>}
      {text !== null &&
        (kind === 'html' && !source ? (
          <iframe
            className="artifact-frame"
            title={path}
            srcDoc={text}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
          />
        ) : kind === 'markdown' && !source ? (
          <div className="text-viewer-body">
            <div className="msg-assistant text-viewer-md">
              <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
                {text}
              </Markdown>
            </div>
          </div>
        ) : (
          <div className="text-viewer-body">
            <pre className="text-viewer-plain">{text}</pre>
          </div>
        ))}
    </div>
  );
}
