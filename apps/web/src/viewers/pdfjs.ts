import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';

type PdfjsLib = typeof import('pdfjs-dist');
type PdfjsViewer = typeof import('pdfjs-dist/web/pdf_viewer.mjs');

let loading: Promise<{ lib: PdfjsLib; viewer: PdfjsViewer }> | undefined;

/**
 * Nạp pdf.js theo yêu cầu (chỉ khi mở PDF đầu tiên).
 * pdf_viewer.mjs đọc `globalThis.pdfjsLib`, nên phải gán nó trước khi import viewer.
 */
export function loadPdfjs() {
  loading ??= (async () => {
    const lib = await import('pdfjs-dist');
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    (globalThis as { pdfjsLib?: PdfjsLib }).pdfjsLib = lib;
    const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
    return { lib, viewer };
  })();
  return loading;
}

/** Tài nguyên được chép vào public/pdfjs bởi scripts/copy-pdfjs-assets.mjs. */
export const PDFJS_ASSETS = {
  cMapUrl: '/pdfjs/cmaps/',
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/',
};
