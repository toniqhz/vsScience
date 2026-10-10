import { useEffect, useMemo, useState } from 'react';
import type { ContentSearchFile, ContentSearchResponse, FindTarget, TreeNode } from '@ide/shared';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { FILE_KIND_META, baseName } from '../fileTypes';
import { dirName, fold } from '../format';

const MAX_NAME_RESULTS = 50;
/** Số chỗ khớp hiện sẵn cho mỗi file; còn lại bấm "Xem thêm". */
const FIRST_MATCHES = 8;

function flattenFiles(node: TreeNode | undefined, out: TreeNode[] = []): TreeNode[] {
  for (const c of node?.children ?? []) {
    if (c.type === 'file') out.push(c);
    else flattenFiles(c, out);
  }
  return out;
}

/** Tô đậm phần khớp trong tên file (so khớp không dấu). */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = fold(query);
  // fold() giữ nguyên độ dài với chữ đã chuẩn hóa NFC, nên vị trí khớp dùng được cho chuỗi gốc.
  const src = text.normalize('NFC');
  const i = q ? fold(src).indexOf(q) : -1;
  if (i < 0) return <>{src}</>;
  return (
    <>
      {src.slice(0, i)}
      <mark>{src.slice(i, i + q.length)}</mark>
      {src.slice(i + q.length)}
    </>
  );
}

type OpenFile = (node: TreeNode, find?: Omit<FindTarget, 'nonce'>) => void;

function FileGroup({ file, node, query, onOpenFile }: { file: ContentSearchFile; node: TreeNode; query: string; onOpenFile: OpenFile }) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const shown = all ? file.matches : file.matches.slice(0, FIRST_MATCHES);
  const hiddenHere = file.matches.length - shown.length;
  const notReturned = file.total - file.matches.length;
  return (
    <div className="search-group">
      <button className="side-row search-file" onClick={() => setOpen((v) => !v)} title={file.path}>
        <span className={`codicon codicon-chevron-${open ? 'down' : 'right'} search-chevron`} />
        <span className={`codicon ${FILE_KIND_META[file.kind].icon} kind-${file.kind}`} />
        <span className="side-row-name">{baseName(file.path)}</span>
        <span className="side-row-dir">{dirName(file.path)}</span>
        <span className="side-badge">{file.total}</span>
      </button>
      {open && (
        <>
          {shown.map((m, i) => (
            <button
              key={i}
              className="side-row search-match"
              title={`${m.loc} — bấm để mở đúng chỗ này`}
              onClick={() => onOpenFile(node, { query, ...m.target })}
            >
              <span className="search-loc">{m.loc}</span>
              <span className="search-snippet">
                {m.snippet.slice(0, m.start)}
                <mark>{m.snippet.slice(m.start, m.end)}</mark>
                {m.snippet.slice(m.end)}
              </span>
            </button>
          ))}
          {hiddenHere > 0 && (
            <button className="side-row search-more" onClick={() => setAll(true)}>
              Xem thêm {hiddenHere} chỗ khớp
            </button>
          )}
          {all && notReturned > 0 && (
            <button className="side-row search-more" onClick={() => onOpenFile(node, { query })}>
              Còn {notReturned} chỗ nữa — mở file để tìm tiếp
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Tìm file theo tên và tìm trong nội dung mọi file (PDF, Word, Excel, PowerPoint, ghi chú…). */
export function SearchView({ onOpenFile }: { onOpenFile: OpenFile }) {
  const { tree } = useWorkspace();
  const [query, setQuery] = useState('');
  const files = useMemo(() => flattenFiles(tree?.root), [tree]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const q = query.trim();

  const nameResults = useMemo(() => {
    const fq = fold(q);
    if (!fq) return [];
    return files
      .map((f) => ({ f, inName: fold(f.name).indexOf(fq), inPath: fold(f.id).indexOf(fq) }))
      .filter((r) => r.inPath >= 0)
      .sort((a, b) => (a.inName < 0 ? 1 : 0) - (b.inName < 0 ? 1 : 0) || a.f.name.localeCompare(b.f.name, 'vi'))
      .slice(0, MAX_NAME_RESULTS)
      .map((r) => r.f);
  }, [files, q]);

  // Tìm trong nội dung: chờ gõ xong; bỏ kết quả của lần tìm cũ nếu đã gõ tiếp.
  const [content, setContent] = useState<{ q: string; res: ContentSearchResponse } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (fold(q).length < 2) {
      setContent(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      api.searchContent(q).then(
        (res) => {
          if (!alive) return;
          setContent({ q, res });
          setError(null);
          setLoading(false);
        },
        (e: Error) => {
          if (!alive) return;
          setError(e.message);
          setLoading(false);
        },
      );
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [q, tree]);

  const res = content?.res;
  const matchTotal = res?.files.reduce((n, f) => n + f.total, 0) ?? 0;
  const nodeOf = (f: ContentSearchFile): TreeNode =>
    byPath.get(f.path) ?? { id: f.path, name: baseName(f.path), type: 'file', kind: f.kind };

  return (
    <div className="explorer">
      <div className="explorer-title">
        <span className="sidebar-title">Tìm kiếm</span>
      </div>
      <div className="side-search">
        <input
          autoFocus
          value={query}
          placeholder="Tìm tên file hoặc nội dung"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Tìm trong thư mục"
        />
      </div>
      <div className="side-list">
        {!q && (
          <div className="side-count">
            Tìm theo tên file và trong nội dung mọi file: PDF, Word, Excel, PowerPoint, ghi chú… Không cần gõ dấu.
          </div>
        )}

        {q && nameResults.length > 0 && (
          <>
            <div className="side-section">
              Tên file <span className="side-badge">{nameResults.length}</span>
            </div>
            {nameResults.map((f) => (
              <button key={f.id} className="side-row" onClick={() => onOpenFile(f)} title={f.id}>
                <span className={`codicon ${FILE_KIND_META[f.kind ?? 'pdf'].icon} kind-${f.kind}`} />
                <span className="side-row-name">
                  <Highlight text={f.name} query={q} />
                </span>
                <span className="side-row-dir">{dirName(f.id)}</span>
              </button>
            ))}
          </>
        )}

        {fold(q).length >= 2 && (
          <>
            <div className="side-section">
              Trong nội dung {res && res.files.length > 0 && <span className="side-badge">{matchTotal}</span>}
              {loading && <span className="codicon codicon-loading codicon-modifier-spin search-spinner" title="Đang tìm…" />}
            </div>
            {error && <div className="side-count is-error">{error}</div>}
            {!res && loading && <div className="side-count">Đang đọc nội dung các file… (lần đầu có thể mất vài giây)</div>}
            {res && content?.q === q && res.files.length === 0 && !loading && (
              <div className="side-count">Không thấy trong nội dung {res.scanned} file.</div>
            )}
            {res && res.files.length > 0 && (
              <div className="side-count">
                {matchTotal} chỗ khớp trong {res.files.length} file
                {res.truncated && ' (quá nhiều, chỉ hiện một phần — gõ cụ thể hơn)'}
              </div>
            )}
            {res?.files.map((f) => (
              <FileGroup key={`${content!.q}:${f.path}`} file={f} node={nodeOf(f)} query={content!.q} onOpenFile={onOpenFile} />
            ))}
            {res?.pdfUnavailable && <div className="side-count">Chưa tìm được trong file PDF: máy thiếu bộ đọc PDF đi kèm app.</div>}
            {res?.scannedPdfs && res.scannedPdfs.length > 0 && (
              <div className="side-count" title={res.scannedPdfs.map((p) => `${p.path}: ${p.pages} trang`).join('\n')}>
                {res.scannedPdfs.length} file PDF có trang ảnh quét chưa có chữ nên không tìm được trong các trang đó. Gõ <code>/ocr</code> trong khung chat
                để Claude nhận dạng chữ.
              </div>
            )}
          </>
        )}
        {q && fold(q).length < 2 && nameResults.length === 0 && <div className="side-count">Không tìm thấy file nào.</div>}
      </div>
    </div>
  );
}
