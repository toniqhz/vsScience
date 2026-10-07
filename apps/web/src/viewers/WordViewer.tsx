import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { OpenExternalButton } from './OpenExternalButton';

type Status = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };

/** Nhận dạng file theo mấy byte đầu: docx là file zip ("PK"), .doc đời cũ là OLE (D0 CF 11 E0). */
function notDocxReason(data: Uint8Array): string | null {
  if (data.length === 0) return 'File Word này trống (0 byte).';
  if (data[0] === 0x50 && data[1] === 0x4b) return null;
  if (data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0)
    return 'Đây là file Word đời cũ (.doc), chưa xem được. Mở bằng Word và lưu lại thành .docx.';
  return 'File bị hỏng hoặc không phải file Word thật (chỉ có đuôi .docx).';
}

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
/** Lề quanh trang (padding của .docx-wrapper, bị phóng theo zoom) và chỗ cho thanh cuộn. */
const PAGE_GUTTER = 32;
const SCROLLBAR = 12;

/** Xem file Word (.docx) bằng docx-preview: dựng trang giấy trong trình duyệt, chỉ đọc. */
export function WordViewer({ path }: { path: string }) {
  const { onFileChange } = useWorkspace();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [scale, setScale] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);

  // Tải lại khi file thay đổi trên đĩa (giữ vị trí cuộn).
  useEffect(() => onFileChange(path, () => setReloadKey((k) => k + 1)), [path, onFileChange]);

  useEffect(() => {
    const body = bodyRef.current;
    const styles = styleRef.current;
    if (!body || !styles) return;
    let cancelled = false;
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    (async () => {
      if (!body.childElementCount) setStatus({ state: 'loading' });
      const [{ renderAsync }, data] = await Promise.all([import('docx-preview'), api.fileBytes(path)]);
      if (cancelled) return;
      const bad = notDocxReason(data);
      if (bad) throw new Error(bad);
      const nextBody = document.createElement('div');
      const nextStyles = document.createElement('div');
      await renderAsync(data, nextBody, nextStyles, {
        className: 'docx',
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        renderComments: false,
        renderChanges: false,
        useBase64URL: true,
      });
      if (cancelled) return;
      // Dựng xong mới thay nội dung cũ để không nháy trắng khi tải lại.
      styles.replaceChildren(...nextStyles.childNodes);
      body.replaceChildren(...nextBody.childNodes);
      setStatus({ state: 'ready' });
      if (scrollRef.current) scrollRef.current.scrollTop = scrollTop;
    })().catch((err: unknown) => {
      if (cancelled) return;
      const msg = (err as Error)?.message ?? '';
      setStatus({
        state: 'error',
        message: /zip|central directory|signature/i.test(msg) ? 'File Word bị hỏng, không đọc được nội dung.' : msg || 'Không mở được file Word.',
      });
    });
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);

  // "Vừa chiều ngang": tính tỉ lệ theo trang rộng nhất mỗi khi khung đổi kích thước.
  useEffect(() => {
    const host = scrollRef.current;
    if (!host || !fitWidth || status.state !== 'ready') return;
    const fit = () => {
      if (host.clientWidth === 0) return; // tab đang ẩn
      const pages = [...(bodyRef.current?.querySelectorAll<HTMLElement>('section.docx') ?? [])];
      // Kích thước tính theo CSS (chưa nhân zoom) nên không phụ thuộc mức phóng hiện tại.
      const widest = Math.max(0, ...pages.map((p) => parseFloat(getComputedStyle(p).width) || 0));
      if (widest) setScale(Math.min(2, Math.max(0.3, (host.clientWidth - SCROLLBAR) / (widest + PAGE_GUTTER))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [fitWidth, status.state, reloadKey]);

  const zoom = (dir: 1 | -1) => {
    const next =
      dir > 0 ? ZOOM_STEPS.find((s) => s > scale + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < scale - 0.001);
    if (next) {
      setFitWidth(false);
      setScale(next);
    }
  };

  return (
    <div className="pdf-viewer">
      <div className="viewer-toolbar">
        <span className="toolbar-group viewer-info">
          <span className="codicon codicon-file-text kind-word" />
          Word
        </span>
        <span className="toolbar-group">
          <button className="icon-btn" title="Thu nhỏ" onClick={() => zoom(-1)}>
            <span className="codicon codicon-zoom-out" />
          </button>
          <span className="zoom-label">{Math.round(scale * 100)}%</span>
          <button className="icon-btn" title="Phóng to" onClick={() => zoom(1)}>
            <span className="codicon codicon-zoom-in" />
          </button>
          <button className={`icon-btn ${fitWidth ? 'is-active' : ''}`} title="Vừa chiều ngang" onClick={() => setFitWidth(true)}>
            <span className="codicon codicon-screen-full" />
          </button>
        </span>
        <span className="toolbar-group toolbar-search">
          <OpenExternalButton path={path} app="Word" />
        </span>
      </div>
      <div className="pdf-scroll-host">
        <div ref={scrollRef} className="pdf-container word-container">
          <div ref={styleRef} />
          <div ref={bodyRef} className="word-body" style={{ zoom: scale }} />
        </div>
        {status.state === 'loading' && <div className="viewer-overlay">Đang mở tài liệu…</div>}
        {status.state === 'error' && (
          <div className="viewer-overlay is-error">
            <span className="codicon codicon-warning" /> {status.message}
          </div>
        )}
      </div>
    </div>
  );
}
