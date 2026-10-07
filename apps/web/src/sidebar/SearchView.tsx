import { useMemo, useState } from 'react';
import type { TreeNode } from '@ide/shared';
import { useWorkspace } from '../api/workspace';
import { FILE_KIND_META } from '../fileTypes';
import { dirName, fold } from '../format';

const MAX_RESULTS = 200;

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

/** Tìm file theo tên hoặc đường dẫn trong thư mục làm việc. */
export function SearchView({ onOpenFile }: { onOpenFile: (node: TreeNode) => void }) {
  const { tree } = useWorkspace();
  const [query, setQuery] = useState('');
  const files = useMemo(() => flattenFiles(tree?.root), [tree]);

  const results = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return [];
    return files
      .map((f) => ({ f, inName: fold(f.name).indexOf(q), inPath: fold(f.id).indexOf(q) }))
      .filter((r) => r.inPath >= 0)
      .sort((a, b) => (a.inName < 0 ? 1 : 0) - (b.inName < 0 ? 1 : 0) || a.f.name.localeCompare(b.f.name, 'vi'))
      .slice(0, MAX_RESULTS)
      .map((r) => r.f);
  }, [files, query]);

  return (
    <div className="explorer">
      <div className="explorer-title">
        <span className="sidebar-title">Tìm kiếm</span>
      </div>
      <div className="side-search">
        <input
          autoFocus
          value={query}
          placeholder="Tìm theo tên file"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Tìm file"
        />
      </div>
      <div className="side-list">
        {query.trim() && (
          <div className="side-count">{results.length === 0 ? 'Không tìm thấy file nào.' : `${results.length} file`}</div>
        )}
        {results.map((f) => (
          <button key={f.id} className="side-row" onClick={() => onOpenFile(f)} title={f.id}>
            <span className={`codicon ${FILE_KIND_META[f.kind ?? 'pdf'].icon} kind-${f.kind}`} />
            <span className="side-row-name">
              <Highlight text={f.name} query={query.trim()} />
            </span>
            <span className="side-row-dir">{dirName(f.id)}</span>
          </button>
        ))}
        {!query.trim() && <div className="side-count">Gõ tên file để tìm (không cần gõ dấu).</div>}
      </div>
    </div>
  );
}
