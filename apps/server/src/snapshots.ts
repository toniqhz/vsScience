import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import git from 'isomorphic-git';
import type { ChangedFile, ChangesResponse, FileDiff } from '@ide/shared';
import { comparableLines } from './docText.js';
import { PathError, fileKind, isHiddenName, resolveInWorkspace } from './paths.js';
import { diffLines } from './textDiff.js';

const AUTHOR = { name: 'Bàn làm việc', email: 'ban-lam-viec@localhost' };
/** File lớn hơn mức này không đưa vào bản lưu. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Chỉ theo dõi file Word/Excel/PDF, bỏ qua file và thư mục ẩn. */
function tracked(filepath: string): boolean {
  if (!fileKind(filepath)) return false;
  return !filepath.split('/').some(isHiddenName);
}

/**
 * Bản lưu phiên bản bằng git chạy ngầm (isomorphic-git, không cần cài git).
 * Kho git nằm ngoài thư mục làm việc (~/.config/ide/snapshots/<mã>) để không
 * thêm thư mục .git vào thư mục tài liệu của người dùng.
 */
export class Snapshots {
  #root = '';
  #gitdir = '';
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly baseDir: string) {}

  /** Chạy tuần tự các thao tác git để không giẫm lên nhau. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  #repo() {
    return { fs, dir: this.#root, gitdir: this.#gitdir };
  }

  /** Mở (hoặc tạo) kho bản lưu cho thư mục làm việc. Lần đầu lưu "Bản đầu tiên". */
  open(root: string): Promise<void> {
    return this.#serial(async () => {
      this.#root = root;
      const id = createHash('sha1').update(root).digest('hex').slice(0, 16);
      this.#gitdir = path.join(this.baseDir, id);
      if (!fs.existsSync(path.join(this.#gitdir, 'HEAD'))) {
        await mkdir(this.#gitdir, { recursive: true });
        await git.init({ ...this.#repo(), defaultBranch: 'main' });
        await writeFile(path.join(this.#gitdir, 'ide-root'), root + '\n');
        await this.#commitAll('Bản đầu tiên');
      }
    });
  }

  async #head(): Promise<string | null> {
    try {
      return await git.resolveRef({ ...this.#repo(), ref: 'HEAD' });
    } catch {
      return null;
    }
  }

  async #changed(): Promise<ChangedFile[]> {
    const matrix = await git.statusMatrix({ ...this.#repo(), filter: tracked });
    const files: ChangedFile[] = [];
    for (const [filepath, head, workdir] of matrix) {
      if (head === 0 && workdir === 2) files.push({ path: filepath, status: 'added' });
      else if (head === 1 && workdir === 0) files.push({ path: filepath, status: 'deleted' });
      else if (head === 1 && workdir === 2) files.push({ path: filepath, status: 'modified' });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path, 'vi'));
  }

  /** Lưu mọi thay đổi thành một bản lưu. Trả về false nếu không có gì thay đổi. */
  async #commitAll(message: string): Promise<boolean> {
    const changed = await this.#changed();
    let staged = 0;
    for (const f of changed) {
      if (f.status === 'deleted') {
        await git.remove({ ...this.#repo(), filepath: f.path });
        staged++;
        continue;
      }
      const st = await stat(path.join(this.#root, f.path)).catch(() => null);
      if (!st || st.size > MAX_FILE_BYTES) continue;
      await git.add({ ...this.#repo(), filepath: f.path });
      staged++;
    }
    const head = await this.#head();
    if (staged === 0 && head) return false;
    await git.commit({ ...this.#repo(), message, author: AUTHOR });
    return true;
  }

  snapshot(message: string): Promise<boolean> {
    return this.#serial(() => this.#commitAll(message.trim() || 'Bản lưu'));
  }

  status(): Promise<ChangesResponse> {
    return this.#serial(async () => {
      const files = await this.#changed();
      const commits = await git.log({ ...this.#repo(), depth: 30 }).catch(() => []);
      return {
        files,
        snapshots: commits.map((c) => ({
          id: c.oid,
          message: c.commit.message.trim(),
          time: c.commit.author.timestamp * 1000,
        })),
      };
    });
  }

  async #headBlob(filepath: string): Promise<Uint8Array | null> {
    const head = await this.#head();
    if (!head) return null;
    try {
      return (await git.readBlob({ ...this.#repo(), oid: head, filepath })).blob;
    } catch {
      return null;
    }
  }

  /** So sánh file với bản lưu gần nhất (Word theo đoạn văn, Excel theo ô). */
  diff(filepath: string): Promise<FileDiff> {
    return this.#serial(async () => {
      if (!tracked(filepath)) throw new PathError('Không hỗ trợ loại file này', 415);
      const status = (await this.#changed()).find((f) => f.path === filepath)?.status;
      if (!status) return { path: filepath, status: null, change: null, note: 'File không còn thay đổi so với bản lưu gần nhất.' };
      const before = await this.#headBlob(filepath);
      const abs = path.join(this.#root, filepath);
      const after = status === 'deleted' ? null : await readFile(abs).catch(() => null);
      const oldLines = comparableLines(filepath, before);
      const newLines = comparableLines(filepath, after ? new Uint8Array(after) : null);
      if (oldLines === null || newLines === null) {
        const size = (b: Uint8Array | Buffer | null) => (b ? `${Math.round(b.length / 1024)} KB` : '—');
        return {
          path: filepath,
          status,
          change: null,
          note:
            fileKind(filepath) === 'pdf'
              ? `File PDF đã thay đổi (${size(before)} → ${size(after)}). Chưa so sánh được nội dung PDF.`
              : 'Không đọc được nội dung để so sánh.',
        };
      }
      const change = diffLines(oldLines, newLines, filepath, status === 'added' ? 'create' : 'edit');
      const unit = fileKind(filepath) === 'excel' ? 'ô' : fileKind(filepath) === 'word' ? 'đoạn' : 'dòng';
      return {
        path: filepath,
        status,
        change,
        note: change.hunks.length === 0 ? 'Nội dung chữ không đổi (có thể chỉ đổi định dạng).' : `So sánh theo ${unit}.`,
      };
    });
  }

  /** Hoàn tác thay đổi của một file về bản lưu gần nhất (file mới thì xóa đi). */
  restore(relPath: string): Promise<void> {
    return this.#serial(async () => {
      if (!tracked(relPath)) throw new PathError('Không hỗ trợ loại file này', 415);
      const status = (await this.#changed()).find((f) => f.path === relPath)?.status;
      if (!status) throw new PathError('File này không có thay đổi', 404);
      if (status === 'added') {
        const abs = await resolveInWorkspace(this.#root, relPath);
        await unlink(abs);
        return;
      }
      const blob = await this.#headBlob(relPath);
      if (!blob) throw new PathError('Không tìm thấy bản lưu của file này', 404);
      const abs = path.join(this.#root, ...relPath.split('/'));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, blob);
    });
  }
}
