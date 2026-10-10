import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { FindTarget } from '@ide/shared';
import type { CellObject, WorkBook, WorkSheet } from 'xlsx';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { fold } from '../format';
import { FindBar } from './find';
import { OpenExternalButton } from './OpenExternalButton';

type Status = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };

/** Giới hạn ô hiển thị để bảng rất lớn không làm treo trình duyệt. */
const MAX_ROWS = 2000;
const MAX_COLS = 200;
const DEFAULT_COL_PX = 88;

type XLSX = typeof import('xlsx');

type Grid = {
  rows: number;
  cols: number;
  truncated: boolean;
  widths: number[];
  /** "r:c" của ô bị gộp vào ô khác (không vẽ). */
  hidden: Set<string>;
  /** "r:c" của ô đầu vùng gộp → số hàng/cột chiếm. */
  spans: Map<string, { rowSpan: number; colSpan: number }>;
};

function buildGrid(X: XLSX, ws: WorkSheet): Grid {
  const ref = ws['!ref'];
  if (!ref) return { rows: 0, cols: 0, truncated: false, widths: [], hidden: new Set(), spans: new Map() };
  const range = X.utils.decode_range(ref);
  // Luôn bắt đầu từ A1 để số hàng/cột khớp với Excel.
  const rows = Math.min(range.e.r + 1, MAX_ROWS);
  const cols = Math.min(range.e.c + 1, MAX_COLS);
  const widths = Array.from({ length: cols }, (_, c) => {
    const info = ws['!cols']?.[c];
    if (info?.hidden) return 0;
    if (info?.wpx) return Math.round(info.wpx);
    if (info?.wch) return Math.round(info.wch * 7 + 5);
    return DEFAULT_COL_PX;
  });
  const hidden = new Set<string>();
  const spans = new Map<string, { rowSpan: number; colSpan: number }>();
  for (const m of ws['!merges'] ?? []) {
    if (m.s.r >= rows || m.s.c >= cols) continue;
    const er = Math.min(m.e.r, rows - 1);
    const ec = Math.min(m.e.c, cols - 1);
    spans.set(`${m.s.r}:${m.s.c}`, { rowSpan: er - m.s.r + 1, colSpan: ec - m.s.c + 1 });
    for (let r = m.s.r; r <= er; r++) for (let c = m.s.c; c <= ec; c++) if (r !== m.s.r || c !== m.s.c) hidden.add(`${r}:${c}`);
  }
  return { rows, cols, truncated: range.e.r + 1 > MAX_ROWS || range.e.c + 1 > MAX_COLS, widths, hidden, spans };
}

function cellText(cell: CellObject | undefined): string {
  if (!cell) return '';
  if (cell.w !== undefined) return cell.w;
  if (cell.v === undefined || cell.v === null) return '';
  if (cell.v instanceof Date) return cell.v.toLocaleDateString('vi-VN');
  return String(cell.v);
}

type CellHit = { s: number; r: number; c: number };

/** Ô có chữ khớp từ khóa trong mọi trang tính (không ẩn), theo thứ tự trang → hàng → cột. */
function findCells(X: XLSX, wb: WorkBook, query: string): CellHit[] {
  const q = fold(query.trim().replace(/\s+/g, ' '));
  if (!q) return [];
  const hits: CellHit[] = [];
  wb.SheetNames.forEach((name, s) => {
    if (wb.Workbook?.Sheets?.[s]?.Hidden) return;
    const ws = wb.Sheets[name];
    if (!ws) return;
    for (const key of Object.keys(ws)) {
      if (key.startsWith('!')) continue;
      const { r, c } = X.utils.decode_cell(key);
      if (r >= MAX_ROWS || c >= MAX_COLS) continue;
      if (fold(cellText(ws[key] as CellObject).replace(/\s+/g, ' ')).includes(q)) hits.push({ s, r, c });
    }
  });
  return hits.sort((a, b) => a.s - b.s || a.r - b.r || a.c - b.c);
}

/** Xem file Excel/CSV bằng SheetJS: lưới ô kiểu bảng tính, thẻ trang tính ở dưới, chỉ đọc. */
export function ExcelViewer({ path, find: target }: { path: string; find?: FindTarget }) {
  const { onFileChange } = useWorkspace();
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [book, setBook] = useState<{ X: XLSX; wb: WorkBook } | null>(null);
  const [sheet, setSheet] = useState(0);
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [hitIndex, setHitIndex] = useState(0);
  /** Ô cần tới sau khi tìm (mở từ kết quả tìm kiếm). */
  const pendingRef = useRef<FindTarget | null>(null);

  useEffect(() => onFileChange(path, () => setReloadKey((k) => k + 1)), [path, onFileChange]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [X, data] = await Promise.all([import('xlsx'), api.fileBytes(path)]);
      if (cancelled) return;
      const isCsv = /\.csv$/i.test(path);
      if (data.length === 0) throw new Error('File này trống (0 byte).');
      // xlsx/xlsm là zip ("PK"); khác đi thì SheetJS sẽ đọc nhầm thành bảng chữ. Không chặn .xls vì
      // nhiều phần mềm xuất .xls thực chất là HTML, SheetJS vẫn đọc được.
      const zip = data[0] === 0x50 && data[1] === 0x4b;
      if (/\.xls[xm]$/i.test(path) && !zip) throw new Error('File bị hỏng hoặc không phải file Excel thật (chỉ có đuôi .xlsx).');
      // CSV đọc dưới dạng chữ UTF-8 để giữ tiếng Việt; file Excel đọc dạng nhị phân.
      const wb = isCsv
        ? X.read(new TextDecoder().decode(data), { type: 'string', cellDates: true })
        : X.read(data, { type: 'array', cellDates: true, cellFormula: true, cellStyles: true });
      setBook({ X, wb });
      setSheet((s) => (s < wb.SheetNames.length ? s : 0));
      setStatus({ state: 'ready' });
    })().catch((err: unknown) => {
      if (cancelled) return;
      const msg = (err as Error)?.message ?? '';
      setStatus({ state: 'error', message: /password|encrypt/i.test(msg) ? 'File Excel này có mật khẩu, hiện chưa mở được.' : msg || 'Không mở được file Excel.' });
    });
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);

  const hits = useMemo(() => (book ? findCells(book.X, book.wb, deferredQuery) : []), [book, deferredQuery]);
  const hitKeys = useMemo(() => new Set(hits.filter((h) => h.s === sheet).map((h) => `${h.r}:${h.c}`)), [hits, sheet]);

  const goToHit = (i: number) => {
    const h = hits[i];
    if (!h) return;
    setHitIndex(i);
    setSheet(h.s);
    setSelected({ r: h.r, c: h.c });
  };

  useEffect(() => {
    if (!target) return;
    // Link chỉ có ô (không kèm cụm từ): chọn thẳng ô đó.
    if (!target.query.trim()) {
      if (!book || !target.cell) return;
      const s = target.sheet !== undefined ? book.wb.SheetNames.indexOf(target.sheet) : sheet;
      setSheet(s >= 0 ? s : sheet);
      setSelected(book.X.utils.decode_cell(target.cell));
      return;
    }
    pendingRef.current = target;
    setQuery(target.query);
  }, [target?.nonce, book]);

  // Từ khóa mới (hoặc mở từ kết quả tìm kiếm): tới ô khớp đầu tiên / ô được chỉ định.
  useEffect(() => {
    if (!book || !hits.length) return;
    const want = pendingRef.current;
    if (want && fold(want.query.trim()) !== fold(deferredQuery.trim())) return;
    pendingRef.current = null;
    let i = 0;
    if (want?.cell && want.sheet !== undefined) {
      const s = book.wb.SheetNames.indexOf(want.sheet);
      const { r, c } = book.X.utils.decode_cell(want.cell);
      i = Math.max(0, hits.findIndex((h) => h.s === s && h.r === r && h.c === c));
    } else if (want?.row !== undefined) {
      i = Math.max(0, hits.findIndex((h) => h.r === want.row));
    }
    goToHit(i);
  }, [hits, book]);

  // Cuộn tới ô đang chọn sau khi bảng vẽ xong.
  useEffect(() => {
    if (!selected) return;
    scrollRef.current
      ?.querySelector(`td[data-rc="${selected.r}:${selected.c}"]`)
      ?.scrollIntoView({ block: 'center', inline: 'center' });
  }, [selected, sheet]);

  const sheetName = book?.wb.SheetNames[sheet];
  const ws = sheetName ? book?.wb.Sheets[sheetName] : undefined;
  const grid = useMemo(() => (book && ws ? buildGrid(book.X, ws) : null), [book, ws]);
  const X = book?.X;

  const selCell = X && ws && selected ? (ws[X.utils.encode_cell(selected)] as CellObject | undefined) : undefined;
  const selAddress = X && selected ? X.utils.encode_cell(selected) : '';
  const selContent = selCell?.f ? `=${selCell.f}` : selCell?.v instanceof Date ? cellText(selCell) : selCell?.v !== undefined ? String(selCell.v) : '';

  return (
    <div className="excel-viewer" ref={rootRef}>
      <div className="viewer-toolbar formula-bar">
        <span className="cell-address">{selAddress}</span>
        <span className="formula-fx">fx</span>
        <span className="formula-content" title={selContent}>
          {selContent}
        </span>
        <FindBar
          rootRef={rootRef}
          query={query}
          onQuery={setQuery}
          count={query.trim() ? { current: hits.length ? hitIndex + 1 : 0, total: hits.length } : null}
          onStep={(dir) => hits.length && goToHit((hitIndex + dir + hits.length) % hits.length)}
          placeholder="Tìm trong bảng tính"
        />
        <OpenExternalButton path={path} app="Excel" />
      </div>
      <div className="sheet-scroll" ref={scrollRef}>
        {grid && X && ws && grid.rows > 0 && (
          <table className="sheet-grid">
            <colgroup>
              <col style={{ width: 44 }} />
              {grid.widths.map((w, c) => (
                <col key={c} style={{ width: w, visibility: w === 0 ? 'collapse' : undefined }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="corner" />
                {grid.widths.map((_, c) => (
                  <th key={c} className={selected?.c === c ? 'is-sel' : ''}>
                    {X.utils.encode_col(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: grid.rows }, (_, r) => {
                const rowInfo = ws['!rows']?.[r];
                if (rowInfo?.hidden) return null;
                return (
                  <tr key={r} style={rowInfo?.hpx ? { height: rowInfo.hpx } : undefined}>
                    <th className={selected?.r === r ? 'is-sel' : ''}>{r + 1}</th>
                    {grid.widths.map((_, c) => {
                      const key = `${r}:${c}`;
                      if (grid.hidden.has(key)) return null;
                      const cell = ws[X.utils.encode_cell({ r, c })] as CellObject | undefined;
                      const span = grid.spans.get(key);
                      const isSel = selected?.r === r && selected?.c === c;
                      return (
                        <td
                          key={c}
                          rowSpan={span?.rowSpan}
                          colSpan={span?.colSpan}
                          data-rc={key}
                          className={`${cell?.t === 'n' || cell?.t === 'd' || typeof cell?.v === 'number' ? 'is-num' : ''} ${cell?.t === 'e' ? 'is-err' : ''} ${isSel ? 'is-sel' : ''} ${hitKeys.has(key) ? 'is-match' : ''}`}
                          onClick={() => setSelected({ r, c })}
                        >
                          {cellText(cell)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {grid && grid.rows === 0 && <div className="placeholder-panel">Trang tính này trống.</div>}
        {grid?.truncated && (
          <div className="sheet-truncated">
            Bảng quá lớn: chỉ hiện {MAX_ROWS} hàng × {MAX_COLS} cột đầu tiên.
          </div>
        )}
        {status.state === 'loading' && <div className="viewer-overlay">Đang mở bảng tính…</div>}
        {status.state === 'error' && (
          <div className="viewer-overlay is-error">
            <span className="codicon codicon-warning" /> {status.message}
          </div>
        )}
      </div>
      {book && book.wb.SheetNames.length > 0 && (
        <div className="sheet-tabs" role="tablist">
          {book.wb.SheetNames.map((name, i) => {
            const hiddenSheet = book.wb.Workbook?.Sheets?.[i]?.Hidden;
            if (hiddenSheet) return null;
            return (
              <button
                key={name}
                role="tab"
                aria-selected={i === sheet}
                className={`sheet-tab ${i === sheet ? 'is-active' : ''}`}
                onClick={() => {
                  setSheet(i);
                  setSelected(null);
                }}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
