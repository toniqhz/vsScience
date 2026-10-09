import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import git from 'isomorphic-git';
import type { ChangeStatus, ChangedFile, ChangesResponse, FileDiff, RestoreResult, SnapshotDetail } from '@ide/shared';
import { comparableLines } from './docText.js';
import { PathError, fileKind, isHiddenName, resolveInWorkspace } from './paths.js';
import { diffLines } from './textDiff.js';

const AUTHOR = { name: 'VsScience', email: 'vsscience@localhost' };
/** File lớn hơn mức này không đưa vào bản lưu. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Theo dõi tài liệu, file chữ và ảnh (không đưa zip, video… vào bản lưu); bỏ qua file và thư mục ẩn. */
function tracked(filepath: string): boolean {
  if (fileKind(filepath) === 'other') return false;
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
    const indexTime = await stat(path.join(this.#gitdir, 'index')).then((s) => s.mtimeMs, () => 0);
    for (const [filepath, head, workdir] of matrix) {
      if (head === 0 && workdir === 2) files.push({ path: filepath, status: 'added' });
      else if (head === 1 && workdir === 0) files.push({ path: filepath, status: 'deleted' });
      else if (head === 1 && workdir === 2) files.push({ path: filepath, status: 'modified' });
      else if (head === 1 && workdir === 1 && (await this.#racyModified(filepath, indexTime))) {
        files.push({ path: filepath, status: 'modified' });
      }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path, 'vi'));
  }

  /**
   * isomorphic-git coi file là không đổi nếu kích thước và thời gian sửa (tính theo giây) khớp với
   * chỉ mục. File sửa trong cùng giây với lần lưu bản mà giữ nguyên kích thước (Claude sửa một ô Excel
   * ngay sau khi app tự lưu bản) sẽ bị bỏ sót — "racy git". Với file sửa sát hoặc sau lần ghi chỉ mục,
   * so thẳng nội dung với bản lưu.
   */
  async #racyModified(filepath: string, indexTime: number): Promise<boolean> {
    const abs = path.join(this.#root, filepath);
    const st = await stat(abs).catch(() => null);
    if (!st || st.mtimeMs < indexTime - 2000) return false;
    const head = await this.#head();
    if (!head) return false;
    const [content, saved] = await Promise.all([
      readFile(abs).catch(() => null),
      git.readBlob({ ...this.#repo(), oid: head, filepath }).catch(() => null),
    ]);
    if (!content || !saved) return false;
    const { oid } = await git.hashBlob({ object: new Uint8Array(content) });
    return oid !== saved.oid;
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
      const read = status === 'deleted' ? null : await readFile(abs).catch(() => null);
      return this.#compare(filepath, status, before, read ? new Uint8Array(read) : null);
    });
  }

  /** So sánh hai phiên bản nội dung của một file (Word theo đoạn văn, Excel theo ô). */
  #compare(filepath: string, status: ChangeStatus, before: Uint8Array | null, after: Uint8Array | null): FileDiff {
    const oldLines = comparableLines(filepath, before);
    const newLines = comparableLines(filepath, after);
    if (oldLines === null || newLines === null) {
      const size = (b: Uint8Array | null) => (b ? `${Math.round(b.length / 1024)} KB` : '—');
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
    const kind = fileKind(filepath);
    const unit = kind === 'excel' ? 'ô' : kind === 'word' ? 'đoạn' : kind === 'powerpoint' ? 'đoạn chữ trên từng slide' : 'dòng';
    return {
      path: filepath,
      status,
      change,
      note: change.hunks.length === 0 ? 'Nội dung chữ không đổi (có thể chỉ đổi định dạng).' : `So sánh theo ${unit}.`,
    };
  }

  async #parentOf(oid: string): Promise<string | null> {
    const { commit } = await git.readCommit({ ...this.#repo(), oid });
    return commit.parent[0] ?? null;
  }

  async #blobAt(oid: string | null, filepath: string): Promise<Uint8Array | null> {
    if (!oid) return null;
    try {
      return (await git.readBlob({ ...this.#repo(), oid, filepath })).blob;
    } catch {
      return null;
    }
  }

  /** Các file được theo dõi có trong một bản lưu. */
  async #filesAt(oid: string): Promise<string[]> {
    return (await git.listFiles({ ...this.#repo(), ref: oid })).filter(tracked);
  }

  /** File thay đổi trong một bản lưu so với bản ngay trước nó (giống danh sách file của một commit). */
  async #commitChanges(oid: string): Promise<ChangedFile[]> {
    const parent = await this.#parentOf(oid);
    if (!parent) return (await this.#filesAt(oid)).map((p) => ({ path: p, status: 'added' as const }));
    const files: ChangedFile[] = [];
    await git.walk({
      ...this.#repo(),
      trees: [git.TREE({ ref: parent }), git.TREE({ ref: oid })],
      map: async (filepath, [a, b]) => {
        if (filepath === '.') return undefined;
        const [ta, tb] = [await a?.type(), await b?.type()];
        const [oa, ob] = [await a?.oid(), await b?.oid()];
        if (oa && oa === ob) return null; // không đổi: bỏ qua cả nhánh con
        if (ta === 'tree' || tb === 'tree') return undefined; // thư mục: đi tiếp vào trong
        if (!tracked(filepath)) return null;
        files.push({ path: filepath, status: !oa ? 'added' : !ob ? 'deleted' : 'modified' });
        return null;
      },
    });
    return files.sort((x, y) => x.path.localeCompare(y.path, 'vi'));
  }

  async #snapshotInfo(oid: string) {
    const { commit } = await git.readCommit({ ...this.#repo(), oid });
    return { id: oid, message: commit.message.trim(), time: commit.author.timestamp * 1000 };
  }

  /** Bản lưu kèm danh sách file đã thay đổi trong bản đó. */
  snapshotDetail(oid: string): Promise<SnapshotDetail> {
    return this.#serial(async () => {
      const snapshot = await this.#snapshotInfo(await this.#resolve(oid));
      return { snapshot, files: await this.#commitChanges(snapshot.id) };
    });
  }

  /** So sánh một file trong bản lưu với bản ngay trước nó. */
  snapshotDiff(oid: string, filepath: string): Promise<FileDiff> {
    return this.#serial(async () => {
      if (!tracked(filepath)) throw new PathError('Không hỗ trợ loại file này', 415);
      const id = await this.#resolve(oid);
      const parent = await this.#parentOf(id);
      const before = await this.#blobAt(parent, filepath);
      const after = await this.#blobAt(id, filepath);
      if (!before && !after) throw new PathError('File này không có trong bản lưu', 404);
      const status: ChangeStatus = !before ? 'added' : !after ? 'deleted' : 'modified';
      return this.#compare(filepath, status, before, after);
    });
  }

  /**
   * Đưa file về đúng như trong một bản lưu: một file (`path`) hoặc cả thư mục.
   * Trước khi khôi phục luôn lưu trạng thái hiện tại thành một bản, nên thao tác này hoàn tác được.
   * Với cả thư mục: file không có trong bản đó bị xóa — trừ file chưa từng được lưu (quá lớn).
   */
  restoreSnapshot(oid: string, relPath?: string): Promise<RestoreResult> {
    return this.#serial(async () => {
      const id = await this.#resolve(oid);
      if (relPath !== undefined && !tracked(relPath)) throw new PathError('Không hỗ trợ loại file này', 415);
      const { message } = await this.#snapshotInfo(id);
      await this.#commitAll(`Trước khi khôi phục về bản: ${message.slice(0, 80)}`);
      const head = await this.#head();
      // Bản đang giữ trạng thái trước khi khôi phục (bản vừa tạo, hoặc bản mới nhất nếu không có gì mới).
      const backup = head ? (await this.#snapshotInfo(head)).message : '';
      const targets = relPath !== undefined ? [relPath] : [...new Set([...(await this.#filesAt(id)), ...(head ? await this.#filesAt(head) : [])])];
      let restored = 0;
      let removed = 0;
      for (const p of targets) {
        const want = await this.#blobAt(id, p);
        const abs = this.#absPath(p);
        if (want) {
          const cur = await readFile(abs).catch(() => null);
          if (cur && Buffer.compare(cur, Buffer.from(want)) === 0) continue;
          await mkdir(path.dirname(abs), { recursive: true });
          await writeFile(abs, want);
          restored++;
        } else if (await stat(abs).then(() => true, () => false)) {
          await unlink(abs);
          removed++;
        }
      }
      return { restored, removed, backup };
    });
  }

  /** Đường dẫn tuyệt đối của file trong thư mục làm việc (file có thể chưa tồn tại). */
  #absPath(relPath: string): string {
    const parts = relPath.split('/');
    if (path.isAbsolute(relPath) || parts.some((x) => x === '..' || x === '' || isHiddenName(x))) {
      throw new PathError('Đường dẫn không hợp lệ', 400);
    }
    return path.join(this.#root, ...parts);
  }

  async #resolve(oid: string): Promise<string> {
    if (!/^[0-9a-f]{4,40}$/.test(oid)) throw new PathError('Mã bản lưu không hợp lệ', 400);
    try {
      return await git.expandOid({ ...this.#repo(), oid });
    } catch {
      throw new PathError('Không tìm thấy bản lưu này', 404);
    }
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
