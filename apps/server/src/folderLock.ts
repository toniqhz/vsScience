import path from 'node:path';

/**
 * Khóa thư mục khi Claude đang làm việc, dùng chung cho mọi cửa sổ của app (cùng một tiến trình).
 * Một cửa sổ chỉ được bắt đầu lượt Claude khi không cửa sổ nào khác đang có Claude làm trong cùng thư mục,
 * thư mục cha hay thư mục con của nó — tránh hai phiên cùng sửa một file.
 */
export interface LockHolder {
  /** Mỗi cửa sổ (server) một id. */
  id: string;
  root: string;
  /** Đưa cửa sổ đang giữ khóa lên trước (app desktop). */
  focus?: () => void;
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

function norm(p: string): string {
  const n = path.resolve(p).normalize('NFC');
  return caseInsensitive ? n.toLowerCase() : n;
}

/** Hai thư mục trùng nhau hoặc thư mục này nằm trong thư mục kia. */
export function overlaps(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  const inside = (child: string, parent: string) => child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  return na === nb || inside(na, nb) || inside(nb, na);
}

export class FolderLocks {
  #holders = new Map<string, LockHolder>();
  #listeners = new Set<() => void>();

  /** Cửa sổ khác đang giữ khóa đụng tới thư mục `root`, nếu có. */
  conflict(id: string, root: string): LockHolder | null {
    for (const h of this.#holders.values()) if (h.id !== id && overlaps(h.root, root)) return h;
    return null;
  }

  /** Giữ khóa; trả về cửa sổ đang chặn (và không giữ được) hoặc null khi đã giữ. */
  acquire(holder: LockHolder): LockHolder | null {
    const other = this.conflict(holder.id, holder.root);
    if (other) return other;
    const had = this.#holders.get(holder.id);
    this.#holders.set(holder.id, holder);
    if (!had || had.root !== holder.root) this.#changed();
    return null;
  }

  release(id: string) {
    if (this.#holders.delete(id)) this.#changed();
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #changed() {
    for (const fn of this.#listeners) fn();
  }
}

/** Bộ khóa chung của tiến trình: mọi cửa sổ của app desktop dùng chung. */
export const folderLocks = new FolderLocks();
