import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

/** Xem ảnh. Hiển thị qua thẻ <img> nên ảnh SVG có script cũng không chạy được. Tự tải lại khi ảnh đổi. */
export function ImageViewer({ path }: { path: string }) {
  const { onFileChange } = useWorkspace();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [size, setSize] = useState<string>('');

  useEffect(() => onFileChange(path, () => setReloadKey((k) => k + 1)), [path, onFileChange]);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    api.fileBytes(path).then(
      (data) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(new Blob([data as BlobPart], { type: MIME[ext] ?? 'application/octet-stream' }));
        setUrl(objectUrl);
        setError(null);
      },
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, reloadKey]);

  return (
    <div className="image-viewer">
      <div className="viewer-toolbar">
        <span className="toolbar-group viewer-info">
          <span className="codicon codicon-file-media kind-image" /> Ảnh {size && `· ${size}`}
        </span>
      </div>
      {error && <div className="placeholder-panel">{error}</div>}
      {url && (
        <div className="image-viewer-body">
          <img
            src={url}
            alt={path}
            onLoad={(e) => setSize(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
            onError={() => setError('Không hiển thị được ảnh này (file hỏng hoặc định dạng trình duyệt không đọc được).')}
          />
        </div>
      )}
    </div>
  );
}
