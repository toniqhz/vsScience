import { useEffect, useMemo, useState } from 'react';
import type { CellObject, WorkBook, WorkSheet } from 'xlsx';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
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

/** Xem file Excel/CSV bằng SheetJS: lưới ô kiểu bảng tính, thẻ trang tính ở dưới, chỉ đọc. */
export function ExcelViewer({ path }: { path: string }) {
  const { onFileChange } = useWorkspace();
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [book, setBook] = useState<{ X: XLSX; wb: WorkBook } | null>(null);
  const [sheet, setSheet] = useState(0);
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);

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

  const sheetName = book?.wb.SheetNames[sheet];
  const ws = sheetName ? book?.wb.Sheets[sheetName] : undefined;
  const grid = useMemo(() => (book && ws ? buildGrid(book.X, ws) : null), [book, ws]);
  const X = book?.X;

  const selCell = X && ws && selected ? (ws[X.utils.encode_cell(selected)] as CellObject | undefined) : undefined;
  const selAddress = X && selected ? X.utils.encode_cell(selected) : '';
  const selContent = selCell?.f ? `=${selCell.f}` : selCell?.v instanceof Date ? cellText(selCell) : selCell?.v !== undefined ? String(selCell.v) : '';

  return (
    <div className="excel-viewer">
      <div className="viewer-toolbar formula-bar">
        <span className="cell-address">{selAddress}</span>
        <span className="formula-fx">fx</span>
        <span className="formula-content" title={selContent}>
          {selContent}
        </span>
        <span className="toolbar-search">
          <OpenExternalButton path={path} app="Excel" />
        </span>
      </div>
      <div className="sheet-scroll">
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
                          className={`${cell?.t === 'n' || cell?.t === 'd' || typeof cell?.v === 'number' ? 'is-num' : ''} ${cell?.t === 'e' ? 'is-err' : ''} ${isSel ? 'is-sel' : ''}`}
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
