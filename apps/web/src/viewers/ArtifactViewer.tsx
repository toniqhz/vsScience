import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';

/**
 * Xem một trang (artifact) Claude đã đăng, từ bản sao HTML lưu lúc đăng. Trang chạy trong khung cách ly
 * (sandbox, không cùng nguồn với app) nên script của trang không đụng được tới dữ liệu của app.
 */
export function ArtifactViewer({ id, title, url }: { id: string; title: string; url: string | null }) {
  const { artifactsRev } = useWorkspace();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Claude đăng lại (sửa trang) thì tải bản mới.
  useEffect(() => {
    let alive = true;
    api.artifactContent(id).then(
      (h) => alive && (setHtml(h), setError(null)),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [id, artifactsRev]);

  return (
    <div className="artifact-viewer">
      <div className="viewer-toolbar">
        <span className="toolbar-group viewer-info" title={title}>
          <span className="codicon codicon-preview" />
          {title}
        </span>
        {url && (
          <a className="btn artifact-open" href={url} target="_blank" rel="noreferrer" title={url}>
            <span className="codicon codicon-link-external" /> Mở trên claude.ai
          </a>
        )}
      </div>
      {error && <div className="placeholder-panel">{error}</div>}
      {html !== null && (
        <iframe
          className="artifact-frame"
          title={title}
          srcDoc={html}
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
        />
      )}
    </div>
  );
}
