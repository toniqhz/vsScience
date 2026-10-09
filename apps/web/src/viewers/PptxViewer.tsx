import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { OpenExternalButton } from './OpenExternalButton';

type Status = { state: 'loading' } | { state: 'ready'; slides: number } | { state: 'error'; message: string };

/** Lề hai bên slide và chỗ cho thanh cuộn. */
const GUTTER = 40;

/**
 * Xem file PowerPoint (.pptx) giống xem PDF: các slide xếp dọc, cuộn để xem, chỉ nội dung tĩnh
 * (không hiệu ứng, không chuyển cảnh). Slide co theo bề ngang khung; vẽ lại khi khung đổi cỡ hoặc file đổi trên đĩa.
 */
export function PptxViewer({ path }: { path: string }) {
  const { onFileChange } = useWorkspace();
  const hostRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [width, setWidth] = useState(0);

  useEffect(() => onFileChange(path, () => setReloadKey((k) => k + 1)), [path, onFileChange]);

  // Bề ngang slide theo khung; chỉ vẽ lại khi đổi đáng kể (kéo khung) để không vẽ liên tục.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let t = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        const w = Math.max(320, Math.floor(host.clientWidth - GUTTER));
        setWidth((cur) => (Math.abs(cur - w) > 24 ? w : cur));
      }, 150);
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !width) return;
    let cancelled = false;
    const scrollTop = hostRef.current?.scrollTop ?? 0;
    (async () => {
      if (!body.childElementCount) setStatus({ state: 'loading' });
      // Thư viện khá nặng (kèm phần vẽ biểu đồ): chỉ nạp khi mở file PowerPoint.
      const [{ init }, data] = await Promise.all([import('pptx-preview'), api.fileBytes(path)]);
      if (cancelled) return;
      if (data.length === 0) throw new Error('File PowerPoint này trống (0 byte).');
      if (data[0] !== 0x50 || data[1] !== 0x4b) throw new Error('File bị hỏng hoặc không phải file PowerPoint .pptx thật.');
      // Dựng vào khung mới rồi mới thay, để khi vẽ lại không bị nháy trắng.
      const next = document.createElement('div');
      const previewer = init(next, { width, mode: 'list' });
      await previewer.preview(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      if (cancelled) return;
      body.replaceChildren(next);
      if (hostRef.current) hostRef.current.scrollTop = scrollTop;
      setStatus({ state: 'ready', slides: previewer.slideCount ?? 0 });
    })().catch((e: Error) => !cancelled && setStatus({ state: 'error', message: e.message || 'Không mở được file PowerPoint.' }));
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey, width]);

  return (
    <div className="pdf-viewer">
      <div className="viewer-toolbar">
        <span className="toolbar-group viewer-info">
          <span className="codicon codicon-preview kind-powerpoint" />
          PowerPoint{status.state === 'ready' && status.slides > 0 && ` · ${status.slides} slide`}
        </span>
        <span className="toolbar-group toolbar-search">
          <OpenExternalButton path={path} app="PowerPoint" />
        </span>
      </div>
      <div ref={hostRef} className="pptx-host">
        <div ref={bodyRef} className="pptx-body" />
        {status.state === 'loading' && <div className="viewer-overlay">Đang mở bài trình chiếu…</div>}
        {status.state === 'error' && <div className="placeholder-panel">{status.message}</div>}
      </div>
    </div>
  );
}
