import type { ReactNode } from 'react';
import type { TreeNode } from '@ide/shared';
import { useWorkspace } from '../api/workspace';
import { useWorkbench } from '../workbenchContext';
import { parseDocLink } from './docLink';

function hasFile(node: TreeNode | undefined, path: string): boolean {
  if (!node) return false;
  const want = path.normalize('NFC');
  const walk = (n: TreeNode): boolean => (n.type === 'file' ? n.id.normalize('NFC') === want : (n.children ?? []).some(walk));
  return walk(node);
}

/**
 * Link trong Markdown (câu trả lời của Claude, ghi chú .md): link tới tài liệu trong thư mục mở đúng trang
 * ở khung bên phải; link web mở trình duyệt. `baseDir`: thư mục của file .md chứa link (link tương đối tính từ đó).
 */
export function DocLinkAnchor({ children, href, baseDir }: { children?: ReactNode; href?: string; baseDir?: string }) {
  const { openPath } = useWorkbench();
  const { info, tree } = useWorkspace();
  // Link tới đề mục trong cùng trang (#…): không bao giờ mở ra trình duyệt.
  if (href?.startsWith('#')) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          const id = decodeURIComponent(href.slice(1));
          (e.currentTarget.closest('.text-viewer-body, .transcript') ?? document).querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
        }}
      >
        {children}
      </a>
    );
  }
  const doc = parseDocLink(href, info?.root, { baseDir, exists: (p) => hasFile(tree?.root, p) });
  if (!doc) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  const where = doc.find?.page ? ` · trang ${doc.find.page}` : doc.find?.cell ? ` · ô ${doc.find.cell}` : '';
  return (
    <a
      href="#"
      className="doc-link"
      title={`Mở ${doc.path}${where}${doc.find?.query ? ` · “${doc.find.query}”` : ''}`}
      onClick={(e) => {
        e.preventDefault();
        openPath(doc.path, doc.find);
      }}
    >
      <span className="codicon codicon-file" />
      {children}
    </a>
  );
}
