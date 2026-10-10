import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ContentMatch, ContentSearchFile, ContentSearchResponse, FileKind, TreeNode } from '@ide/shared';
import { docxParagraphs, pptxParagraphs, xlsxCellList } from './docText.js';
import { pdfTextToolPath } from './pdfTool.js';
import { pythonExe, withRuntime } from './runtime.js';

/**
 * Tìm trong nội dung mọi file của thư mục làm việc (ô Tìm kiếm bên trái): PDF theo trang, Word theo
 * đoạn, Excel theo ô, PowerPoint theo slide, file chữ theo dòng. So khớp không phân biệt hoa thường
 * và không cần gõ dấu. Chữ trích ra được nhớ theo (đường dẫn, mtime, cỡ) để lần tìm sau nhanh.
 */

/** Một đơn vị chữ của file (trang, đoạn, ô, dòng…) kèm vị trí để nhảy tới. */
export interface TextUnit {
  loc: string;
  text: string;
  target: ContentMatch['target'];
  /** Không hiện trong khung xem (ghi chú slide): không tính vào thứ tự lần khớp. */
  hidden?: boolean;
}

export interface SearchFile {
  rel: string;
  abs: string;
  kind: FileKind;
  size: number;
  mtime: number;
}

const MAX_TEXT_FILE = 5 * 1024 * 1024;
const MAX_DOC_FILE = 80 * 1024 * 1024;
const MAX_MATCHES_PER_FILE = 50;
const MAX_TOTAL_MATCHES = 3000;
const SNIPPET_BEFORE = 14;
const SNIPPET_AFTER = 80;
const PDF_TIMEOUT_MS = 120_000;
const PDF_BATCH = 40;

/** Bỏ dấu và chữ hoa, giữ nguyên số ký tự với từng ký tự gốc (chữ đã chuẩn hóa NFC). */
export function foldChar(ch: string): string {
  return ch
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

export function fold(s: string): string {
  return [...s.normalize('NFC')].map(foldChar).join('');
}

/** Mọi vị trí khớp [start, end) trong `text` (vị trí theo chuỗi gốc đã NFC). */
export function findAll(text: string, foldedQuery: string): { text: string; hits: [number, number][] } {
  const src = text.normalize('NFC');
  let folded = '';
  /** folded index → vị trí trong src */
  const map: number[] = [];
  let i = 0;
  for (const ch of src) {
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  map.push(src.length);
  const hits: [number, number][] = [];
  if (!foldedQuery) return { text: src, hits };
  for (let at = folded.indexOf(foldedQuery); at >= 0; at = folded.indexOf(foldedQuery, at + foldedQuery.length)) {
    const end = at + foldedQuery.length;
    // Ký tự cuối của phần khớp có thể là một ký tự gốc dài 2 (cặp surrogate): lấy hết ký tự đó.
    const last = map[end - 1]!;
    const lastLen = src.codePointAt(last)! > 0xffff ? 2 : 1;
    hits.push([map[at]!, last + lastLen]);
  }
  return { text: src, hits };
}

function snippetOf(text: string, start: number, end: number): Pick<ContentMatch, 'snippet' | 'start' | 'end'> {
  let a = Math.max(0, start - SNIPPET_BEFORE);
  let b = Math.min(text.length, end + SNIPPET_AFTER);
  // Không cắt giữa từ.
  if (a > 0) {
    const sp = text.indexOf(' ', a);
    if (sp >= 0 && sp < start) a = sp + 1;
  }
  if (b < text.length) {
    const sp = text.lastIndexOf(' ', b);
    if (sp > end) b = sp;
  }
  const prefix = a > 0 ? '…' : '';
  const raw = text.slice(a, b);
  const snippet = prefix + raw + (b < text.length ? '…' : '');
  return { snippet, start: prefix.length + (start - a), end: prefix.length + (end - a) };
}

function lineUnits(text: string): TextUnit[] {
  return text.split(/\r?\n/).map((line, i) => ({ loc: `Dòng ${i + 1}`, text: line, target: { row: i } }));
}

/** Đơn vị chữ của một file không phải PDF; null nếu không đọc được loại này. */
export function textUnits(file: Pick<SearchFile, 'rel' | 'kind'>, data: Uint8Array): TextUnit[] | null {
  const ext = path.extname(file.rel).toLowerCase();
  switch (file.kind) {
    case 'word':
      if (ext !== '.docx') return null;
      return docxParagraphs(data).map((t, i) => ({ loc: `Đoạn ${i + 1}`, text: t, target: {} }));
    case 'excel':
      if (ext === '.csv') return lineUnits(new TextDecoder().decode(data));
      if (ext !== '.xlsx' && ext !== '.xlsm') return null;
      return xlsxCellList(data).map((c) => ({ loc: `${c.sheet} · ${c.ref}`, text: c.value, target: { sheet: c.sheet, cell: c.ref } }));
    case 'powerpoint':
      if (ext !== '.pptx') return null;
      return pptxParagraphs(data).map((p) => {
        const m = /^Slide (\d+)( \(ghi chú\))?: ([\s\S]*)$/.exec(p);
        const slide = Number(m?.[1] ?? 0);
        const note = !!m?.[2];
        return { loc: `Slide ${slide}${note ? ' · ghi chú' : ''}`, text: m?.[3] ?? p, target: {}, ...(note ? { hidden: true } : {}) };
      });
    case 'markdown':
    case 'text':
    case 'html':
      return lineUnits(new TextDecoder().decode(data));
    default:
      return null;
  }
}

function sizeLimit(kind: FileKind): number {
  return kind === 'markdown' || kind === 'text' || kind === 'html' ? MAX_TEXT_FILE : MAX_DOC_FILE;
}

export function flattenFiles(root: string, node: TreeNode | undefined, out: SearchFile[] = []): SearchFile[] {
  for (const c of node?.children ?? []) {
    if (c.type === 'folder') flattenFiles(root, c, out);
    else if (c.kind) out.push({ rel: c.id, abs: path.join(root, ...c.id.split('/')), kind: c.kind, size: c.size ?? 0, mtime: c.mtime ?? 0 });
  }
  return out;
}

type PdfReader = (files: string[]) => Promise<Map<string, string[] | null>>;

/** Đọc chữ nhiều PDF bằng tools/pdftext.py (PyMuPDF). Lỗi từng file → null. */
export const readPdfPages: PdfReader = (files) =>
  new Promise((resolve, reject) => {
    execFile(
      pythonExe(),
      [pdfTextToolPath(), ...files],
      { env: withRuntime(process.env), maxBuffer: 512 * 1024 * 1024, timeout: PDF_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        const out = new Map<string, string[] | null>();
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line) as { file: string; pages?: string[] };
            out.set(r.file, r.pages ?? null);
          } catch {
            // dòng hỏng: bỏ qua
          }
        }
        if (err && out.size === 0) reject(err);
        else resolve(out);
      },
    );
  });

/** File ẩn cạnh PDF chứa chữ nhận dạng từ ảnh trang quét (tools/pdf.py ocr-set). */
export function ocrSidecar(pdfAbs: string): string {
  return path.join(path.dirname(pdfAbs), `.${path.basename(pdfAbs)}.ocr.json`);
}

export class ContentSearch {
  #cache = new Map<string, { key: string; units: TextUnit[] | null }>();
  #pdfUnavailable = false;

  constructor(private readonly readPdf: PdfReader = readPdfPages) {}

  /** Chữ của các file (đọc file mới/đổi, còn lại lấy từ bộ nhớ). */
  async #load(files: SearchFile[]): Promise<void> {
    // PDF: tính cả file chữ nhận dạng từ ảnh trang quét (.<tên>.ocr.json) để đọc lại khi có trang mới được nhận dạng.
    const ocrStamp = new Map<string, number>();
    await Promise.all(
      files
        .filter((f) => f.kind === 'pdf')
        .map(async (f) => {
          const st = await stat(ocrSidecar(f.abs)).catch(() => null);
          if (st) ocrStamp.set(f.abs, st.mtimeMs);
        }),
    );
    const keyOf = (f: SearchFile) => `${f.mtime}:${f.size}:${ocrStamp.get(f.abs) ?? 0}`;
    const stale = files.filter((f) => this.#cache.get(f.abs)?.key !== keyOf(f));
    const pdfs = stale.filter((f) => f.kind === 'pdf');
    const others = stale.filter((f) => f.kind !== 'pdf');

    // File không phải PDF: đọc song song vài file một lúc.
    let next = 0;
    const worker = async () => {
      while (next < others.length) {
        const f = others[next++]!;
        let units: TextUnit[] | null = null;
        try {
          units = textUnits(f, new Uint8Array(await readFile(f.abs)));
        } catch {
          units = null;
        }
        this.#cache.set(f.abs, { key: keyOf(f), units });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    if (pdfs.length === 0) return;
    // PDF cần Python có PyMuPDF (đi kèm app desktop); chạy dev có thể không có → báo pdfUnavailable.
    for (let i = 0; i < pdfs.length; i += PDF_BATCH) {
      const batch = pdfs.slice(i, i + PDF_BATCH);
      let pages: Map<string, string[] | null>;
      try {
        pages = await this.readPdf(batch.map((f) => f.abs));
        this.#pdfUnavailable = false;
      } catch {
        this.#pdfUnavailable = true;
        return;
      }
      for (const f of batch) {
        const p = pages.get(f.abs);
        this.#cache.set(f.abs, {
          key: keyOf(f),
          units: p ? p.map((text, n) => ({ loc: `Trang ${n + 1}`, text, target: { page: n + 1 } })) : null,
        });
      }
    }
  }

  async search(files: SearchFile[], query: string): Promise<ContentSearchResponse> {
    const q = fold(query.trim().replace(/\s+/g, ' '));
    const usable = files.filter((f) => f.size <= sizeLimit(f.kind) && f.kind !== 'image' && f.kind !== 'other');
    if (!q) return { files: [], scanned: 0, truncated: false };
    await this.#load(usable);

    const out: ContentSearchFile[] = [];
    let total = 0;
    let truncated = false;
    let scanned = 0;
    const scannedPdfs: { path: string; pages: number }[] = [];
    for (const f of usable) {
      const units = this.#cache.get(f.abs)?.units;
      if (!units) continue;
      scanned++;
      if (f.kind === 'pdf') {
        const empty = units.filter((u) => !u.text.trim()).length;
        if (empty) scannedPdfs.push({ path: f.rel, pages: empty });
      }
      const file: ContentSearchFile = { path: f.rel, kind: f.kind, total: 0, matches: [] };
      let occurrence = 0;
      for (const u of units) {
        const { text, hits } = findAll(u.text, q);
        for (const [k, [start, end]] of hits.entries()) {
          file.total++;
          if (file.matches.length < MAX_MATCHES_PER_FILE && total < MAX_TOTAL_MATCHES) {
            const target = { ...u.target, ...(u.target.page ? { inPage: k } : {}), ...(u.hidden ? {} : { occurrence }) };
            file.matches.push({ loc: u.loc, ...snippetOf(text, start, end), target });
            total++;
          }
          if (!u.hidden) occurrence++;
        }
      }
      if (file.total) out.push(file);
      if (total >= MAX_TOTAL_MATCHES) {
        truncated = true;
        break;
      }
    }
    return {
      files: out,
      scanned,
      truncated,
      ...(scannedPdfs.length ? { scannedPdfs } : {}),
      ...(this.#pdfUnavailable && usable.some((f) => f.kind === 'pdf') ? { pdfUnavailable: true } : {}),
    };
  }
}

function scannedNote(res: ContentSearchResponse): string[] {
  if (!res.scannedPdfs?.length) return [];
  const list = res.scannedPdfs.slice(0, 10).map((p) => `${p.path} (${p.pages} trang)`).join(', ');
  return ['', `Lưu ý: có trang ảnh quét chưa có chữ nên không tìm được trong đó: ${list}${res.scannedPdfs.length > 10 ? ', …' : ''}. Cần thì chụp trang (render) để đọc, và lưu chữ bằng ocr-set.`];
}

/** Kết quả tìm kiếm dạng chữ cho Claude (công cụ search_documents): file, vị trí, đoạn trích. */
export function formatForClaude(res: ContentSearchResponse, query: string, maxPerFile = 8): string {
  if (!res.files.length) {
    return [
      `Không thấy "${query}" trong nội dung ${res.scanned} file đã đọc.${res.pdfUnavailable ? ' (Chưa đọc được PDF: thiếu bộ đọc PDF.)' : ''} Thử từ khóa khác, từ đồng nghĩa hoặc tiếng Anh.`,
      ...scannedNote(res),
    ].join('\n');
  }
  const total = res.files.reduce((n, f) => n + f.total, 0);
  const lines = [`Tìm thấy ${total} chỗ khớp "${query}" trong ${res.files.length} file (đã đọc ${res.scanned} file)${res.truncated ? ', quá nhiều nên chỉ liệt kê một phần' : ''}:`];
  for (const f of res.files) {
    lines.push('', `## ${f.path} (${f.total} chỗ)`);
    for (const m of f.matches.slice(0, maxPerFile)) lines.push(`- ${m.loc}: ${m.snippet.replace(/\s+/g, ' ')}`);
    if (f.total > maxPerFile) lines.push(`- … còn ${f.total - maxPerFile} chỗ nữa (tìm cụ thể hơn hoặc giới hạn theo thư mục/file)`);
  }
  if (res.pdfUnavailable) lines.push('', '(Chưa đọc được nội dung PDF: thiếu bộ đọc PDF.)');
  lines.push(...scannedNote(res));
  return lines.join('\n');
}
