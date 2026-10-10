import { existsSync, statSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DirEntry, DirListing, ServerEvent, WorkspaceInfo } from '@ide/shared';
import { PathError, isHiddenName } from './paths.js';
import { readState, rememberWorkspace } from './state.js';
import { watchWorkspace } from './watcher.js';

const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
const MAX_DIRS = 2000;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Kiểm tra và chuẩn hóa thư mục người dùng chọn để làm thư mục làm việc. */
export async function validateWorkspaceDir(dir: string): Promise<string> {
  if (!path.isAbsolute(dir)) throw new PathError('Cần đường dẫn đầy đủ tới thư mục', 400);
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    throw new PathError('Không tìm thấy thư mục', 404);
  }
  if (!(await stat(real)).isDirectory()) throw new PathError('Đây không phải thư mục', 400);
  if (path.parse(real).root === real) {
    throw new PathError('Không mở được cả ổ đĩa, hãy chọn một thư mục cụ thể', 400);
  }
  try {
    await readdir(real);
  } catch {
    throw new PathError('Không có quyền đọc thư mục này', 403);
  }
  return real;
}

/**
 * Giữ thư mục làm việc hiện tại và bộ theo dõi file của nó.
 * Đổi thư mục thì đóng watcher cũ, mở watcher mới và báo cho mọi trình duyệt.
 */
export class WorkspaceManager {
  #root = '';
  #watcher: { close(): Promise<void> } | undefined;

  constructor(
    private readonly opts: {
      statePath: string;
      usePolling: boolean;
      watch: boolean;
      emit: (event: ServerEvent) => void;
    },
  ) {}

  get root(): string {
    return this.#root;
  }

  info(): WorkspaceInfo {
    const recent = readState(this.opts.statePath).recent.filter((r) => r !== this.#root && isDir(r));
    return { name: path.basename(this.#root), root: this.#root, recent };
  }

  /** Mở thư mục làm việc. `remember` = ghi vào danh sách gần đây. */
  async open(dir: string, { remember = true } = {}): Promise<WorkspaceInfo> {
    const real = await validateWorkspaceDir(dir);
    if (real !== this.#root) {
      await this.#watcher?.close();
      this.#root = real;
      if (this.opts.watch) {
        this.#watcher = watchWorkspace(real, (changes) => this.opts.emit({ type: 'fs', changes }), {
          usePolling: this.opts.usePolling,
        });
      }
    }
    if (remember) rememberWorkspace(this.opts.statePath, real);
    const info = this.info();
    this.opts.emit({ type: 'hello', workspace: info });
    return info;
  }

  async close() {
    await this.#watcher?.close();
  }
}

function shortcuts(): DirEntry[] {
  const home = homedir();
  const list: DirEntry[] = [{ name: 'Thư mục cá nhân', path: home }];
  for (const [name, sub] of [
    ['Màn hình nền', 'Desktop'],
    ['Tài liệu', 'Documents'],
    ['Tải về', 'Downloads'],
  ] as const) {
    const p = path.join(home, sub);
    if (isDir(p)) list.push({ name, path: p });
  }
  // Trong WSL, ổ C của Windows nằm ở /mnt/c.
  if (process.platform === 'linux' && existsSync('/mnt/c/Users')) {
    list.push({ name: 'Ổ C (Windows)', path: '/mnt/c/Users' });
  }
  return list;
}

/** Liệt kê thư mục con (chỉ tên thư mục, không đọc nội dung file) cho hộp thoại "Mở thư mục". */
export async function listDirs(dir: string | undefined): Promise<DirListing> {
  const target = dir ? path.resolve(dir) : homedir();
  if (dir && !path.isAbsolute(dir)) throw new PathError('Cần đường dẫn đầy đủ', 400);
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new PathError('Không có quyền đọc thư mục này', 403);
    if (code === 'ENOTDIR') throw new PathError('Đây không phải thư mục', 400);
    throw new PathError('Không tìm thấy thư mục', 404);
  }
  const dirs: DirEntry[] = [];
  for (const e of entries) {
    if (dirs.length >= MAX_DIRS) break;
    if (isHiddenName(e.name)) continue;
    const full = path.join(target, e.name);
    if (e.isDirectory() || (e.isSymbolicLink() && isDir(full))) dirs.push({ name: e.name, path: full });
  }
  dirs.sort((a, b) => collator.compare(a.name, b.name));
  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, dirs, shortcuts: shortcuts() };
}
