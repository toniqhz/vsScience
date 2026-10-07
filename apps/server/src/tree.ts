import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TreeNode, TreeResponse } from '@ide/shared';
import { fileKind, isHiddenName, toRelPosix } from './paths.js';

const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 12;

const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
  return collator.compare(a.name, b.name);
}

/**
 * Đọc đệ quy cây thư mục, chỉ giữ thư mục và file Word/Excel/PDF.
 * Bỏ qua symlink để không đi ra ngoài thư mục làm việc hoặc lặp vô hạn.
 */
export async function buildTree(root: string): Promise<TreeResponse> {
  let count = 0;
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<TreeNode[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return []; // không có quyền đọc, hoặc vừa bị xóa
    }
    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (isHiddenName(entry.name) || entry.isSymbolicLink()) continue;
      if (count >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count++;
        let children: TreeNode[] = [];
        if (depth < MAX_DEPTH) children = await walk(abs, depth + 1);
        else truncated = true;
        nodes.push({ id: toRelPosix(root, abs), name: entry.name, type: 'folder', children });
      } else if (entry.isFile()) {
        const kind = fileKind(entry.name);
        if (!kind) continue;
        count++;
        const st = await stat(abs).catch(() => undefined);
        if (!st) continue;
        nodes.push({
          id: toRelPosix(root, abs),
          name: entry.name,
          type: 'file',
          kind,
          size: st.size,
          mtime: st.mtimeMs,
        });
      }
    }
    return nodes.sort(compareNodes);
  }

  const children = await walk(root, 1);
  return {
    root: { id: '', name: path.basename(root), type: 'folder', children },
    truncated,
  };
}
