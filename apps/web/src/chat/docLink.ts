import type { FindTarget } from '@ide/shared';

/**
 * Link tới tài liệu trong thư mục làm việc mà Claude viết trong câu trả lời để dẫn nguồn, ví dụ
 *   [Giáo trình, tr. 45](<Sách/Giáo trình Sinh 11.pdf#page=45&q=pha sáng>)
 * Bấm vào: mở file ở khung bên phải, tới đúng trang/slide/ô và tô cụm từ `q`.
 * Trả về null với link web (http, mailto…) hoặc đường dẫn ra ngoài thư mục làm việc.
 */
export function parseDocLink(href: string | undefined, root: string | undefined): { path: string; find?: Omit<FindTarget, 'nonce'> } | null {
  if (!href) return null;
  let raw = href.trim();
  if (/^file:\/\//i.test(raw)) raw = raw.replace(/^file:\/\/(localhost)?/i, '');
  else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return null; // http:, mailto:… (trừ C:\)
  const hash = raw.indexOf('#');
  const pathPart = hash >= 0 ? raw.slice(0, hash) : raw;
  const frag = hash >= 0 ? raw.slice(hash + 1) : '';
  let p: string;
  try {
    p = decodeURIComponent(pathPart);
  } catch {
    p = pathPart;
  }
  p = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return null;
  // Đường dẫn tuyệt đối: chỉ nhận khi nằm trong thư mục làm việc.
  const isAbs = p.startsWith('/') || /^[a-z]:\//i.test(p);
  if (isAbs) {
    const r = (root ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    const cmp = (s: string) => s.normalize('NFC').toLowerCase();
    if (!r || !cmp(p).startsWith(`${cmp(r)}/`)) return null;
    p = p.slice(r.length + 1);
  }
  if (p.split('/').includes('..')) return null;

  const params = new URLSearchParams(frag.replace(/^\?/, ''));
  const num = (k: string) => {
    const v = Number(params.get(k));
    return Number.isInteger(v) && v > 0 ? v : undefined;
  };
  const query = (params.get('q') ?? params.get('search') ?? '').trim();
  const page = num('page');
  const cellParam = params.get('cell');
  const cellMatch = cellParam ? /^(?:(.+)!)?\$?([A-Z]+)\$?(\d+)$/i.exec(cellParam) : null;
  const row = num('row');
  const find: Omit<FindTarget, 'nonce'> = {
    query,
    ...(page ? { page } : {}),
    ...(cellMatch ? { cell: `${cellMatch[2]!.toUpperCase()}${cellMatch[3]}`, ...(cellMatch[1] ? { sheet: cellMatch[1] } : {}) } : {}),
    ...(row ? { row: row - 1 } : {}),
  };
  const hasTarget = query || page || cellMatch || row;
  return { path: p, ...(hasTarget ? { find } : {}) };
}
