import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { EventBus, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { PDFJS_ASSETS, loadPdfjs } from './pdfjs';

type Status = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

function errorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'PasswordException') return 'File PDF này có mật khẩu, hiện chưa mở được.';
  if (name === 'InvalidPDFException') return 'File này không phải PDF hợp lệ hoặc đã bị hỏng.';
  return (err as Error)?.message || 'Không mở được file PDF.';
}

export function PdfViewer({ path }: { path: string }) {
  const { onFileChange } = useWorkspace();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const eventBusRef = useRef<EventBus | null>(null);
  /** Trang và mức zoom cần khôi phục sau khi tải lại file. */
  const resumeRef = useRef<{ page: number; scale: string } | null>(null);
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<{ current: number; total: number } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Tải lại khi file thay đổi trên đĩa (giữ trang đang xem).
  useEffect(() => onFileChange(path, () => setReloadKey((k) => k + 1)), [path, onFileChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let doc: PDFDocumentProxy | undefined;
    let destroyTask: (() => Promise<void>) | undefined;
    const resume = resumeRef.current;
    resumeRef.current = null;

    (async () => {
      setStatus({ state: 'loading' });
      const [{ lib, viewer: v }, data] = await Promise.all([loadPdfjs(), api.fileBytes(path)]);
      if (cancelled) return;

      container.replaceChildren();
      const inner = document.createElement('div');
      inner.className = 'pdfViewer';
      container.append(inner);

      const eventBus = new v.EventBus();
      const linkService = new v.PDFLinkService({ eventBus });
      const findController = new v.PDFFindController({ eventBus, linkService });
      const viewer = new v.PDFViewer({ container, viewer: inner, eventBus, linkService, findController });
      linkService.setViewer(viewer);
      viewerRef.current = viewer;
      eventBusRef.current = eventBus;

      eventBus.on('pagesinit', () => {
        viewer.currentScaleValue = resume?.scale ?? 'page-width';
        if (resume && resume.page > 1) viewer.currentPageNumber = Math.min(resume.page, viewer.pagesCount);
      });
      eventBus.on('pagechanging', (e: { pageNumber: number }) => {
        setPage(e.pageNumber);
        setPageInput(String(e.pageNumber));
      });
      eventBus.on('scalechanging', (e: { scale: number; presetValue?: string }) => {
        setScale(e.scale);
        setFitWidth(e.presetValue === 'page-width');
      });
      eventBus.on('updatefindmatchescount', (e: { matchesCount: { current: number; total: number } }) =>
        setMatches(e.matchesCount),
      );
      eventBus.on('updatefindcontrolstate', (e: { matchesCount: { current: number; total: number } }) =>
        setMatches(e.matchesCount),
      );

      const task = lib.getDocument({ data, ...PDFJS_ASSETS });
      destroyTask = () => task.destroy();
      doc = await task.promise;
      if (cancelled) return;
      viewer.setDocument(doc);
      linkService.setDocument(doc);
      setPageCount(doc.numPages);
      setStatus({ state: 'ready' });
    })().catch((err: unknown) => {
      if (!cancelled) setStatus({ state: 'error', message: errorMessage(err) });
    });

    return () => {
      cancelled = true;
      const v = viewerRef.current;
      if (v?.pdfDocument) resumeRef.current = { page: v.currentPageNumber, scale: v.currentScaleValue };
      v?.setDocument(null);
      viewerRef.current = null;
      eventBusRef.current = null;
      void destroyTask?.();
    };
  }, [path, reloadKey]);

  // Giữ chế độ "vừa chiều ngang" khi người dùng kéo đổi kích thước khung.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      // Tab đang ẩn (dockview dùng display:none) có kích thước 0 — để nguyên, chỉnh lại khi hiện ra.
      if (container.clientWidth === 0) return;
      const v = viewerRef.current;
      if (v?.pdfDocument && v.currentScaleValue === 'page-width') v.currentScaleValue = 'page-width';
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  const zoom = (dir: 1 | -1) => {
    const v = viewerRef.current;
    if (!v) return;
    const next =
      dir > 0 ? ZOOM_STEPS.find((s) => s > scale + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < scale - 0.001);
    if (next) v.currentScale = next;
  };

  const goToPage = () => {
    const v = viewerRef.current;
    const n = Number(pageInput);
    if (v && Number.isInteger(n) && n >= 1 && n <= pageCount) v.currentPageNumber = n;
    else setPageInput(String(page));
  };

  const find = (again: boolean, previous = false) => {
    if (!query.trim()) {
      setMatches(null);
      return;
    }
    eventBusRef.current?.dispatch('find', {
      source: null,
      type: again ? 'again' : '',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  };

  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') find(!!matches, e.shiftKey);
  };

  return (
    <div className="pdf-viewer">
      <div className="viewer-toolbar">
        <span className="toolbar-group">
          Trang
          <input
            className="page-input"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={goToPage}
            onKeyDown={(e) => e.key === 'Enter' && goToPage()}
            aria-label="Số trang"
          />
          / {pageCount || '…'}
        </span>
        <span className="toolbar-group">
          <button className="icon-btn" title="Thu nhỏ" onClick={() => zoom(-1)}>
            <span className="codicon codicon-zoom-out" />
          </button>
          <span className="zoom-label">{Math.round(scale * 100)}%</span>
          <button className="icon-btn" title="Phóng to" onClick={() => zoom(1)}>
            <span className="codicon codicon-zoom-in" />
          </button>
          <button
            className={`icon-btn ${fitWidth ? 'is-active' : ''}`}
            title="Vừa chiều ngang"
            onClick={() => viewerRef.current && (viewerRef.current.currentScaleValue = 'page-width')}
          >
            <span className="codicon codicon-screen-full" />
          </button>
        </span>
        <span className="toolbar-group toolbar-search">
          <span className="codicon codicon-search" />
          <input
            className="search-input"
            placeholder="Tìm trong tài liệu"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMatches(null);
            }}
            onKeyDown={onFindKey}
          />
          {matches && <span className="match-count">{matches.total ? `${matches.current}/${matches.total}` : 'Không thấy'}</span>}
        </span>
      </div>
      <div className="pdf-scroll-host">
        <div ref={containerRef} className="pdf-container" />
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
