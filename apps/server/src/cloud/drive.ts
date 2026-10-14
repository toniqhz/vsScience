import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Ổ đám mây mà app đồng bộ thư mục làm việc lên (OneDrive, Google Drive…). Đường dẫn dạng "a/b/c.pdf",
 * tính từ thư mục riêng của app trên ổ (OneDrive: Ứng dụng/VsScience).
 */
export interface CloudDrive {
  /** Đọc file nhỏ (manifest…); null nếu chưa có. `etag` dùng để ghi có điều kiện. */
  read(p: string): Promise<{ data: Buffer; etag: string } | null>;
  /**
   * Ghi file nhỏ. `ifMatch`: chỉ ghi nếu file trên ổ vẫn đúng bản đó (null: chỉ ghi nếu chưa có file);
   * không khớp thì ném CloudConflict.
   */
  write(p: string, data: Uint8Array, opts?: { ifMatch?: string | null }): Promise<{ etag: string }>;
  /** Tải một file trên máy lên (file lớn thì chia phần). */
  upload(p: string, absFile: string): Promise<void>;
  /** Tải file về máy; false nếu không có trên ổ. */
  download(p: string, absFile: string): Promise<boolean>;
  remove(p: string): Promise<void>;
  /** Các thư mục ở gốc (mỗi thư mục làm việc đã đồng bộ một thư mục). */
  listFolders(): Promise<string[]>;
}

/** Ghi có điều kiện thất bại: máy khác vừa ghi trước. */
export class CloudConflict extends Error {
  constructor(message = 'Máy khác vừa đồng bộ thư mục này') {
    super(message);
  }
}

export class CloudAuthError extends Error {
  constructor(message = 'Cần kết nối lại tài khoản đám mây') {
    super(message);
  }
}

/** Ổ đám mây giả là một thư mục trên máy: dùng khi test và khi chạy thử chưa có tài khoản thật. */
export class LocalDrive implements CloudDrive {
  constructor(readonly root: string) {}

  #abs(p: string): string {
    const abs = path.resolve(this.root, ...p.split('/'));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error(`Đường dẫn lạ: ${p}`);
    return abs;
  }

  async read(p: string) {
    const data = await readFile(this.#abs(p)).catch(() => null);
    return data ? { data, etag: etagOf(data) } : null;
  }

  async write(p: string, data: Uint8Array, opts: { ifMatch?: string | null } = {}) {
    const abs = this.#abs(p);
    if (opts.ifMatch !== undefined) {
      const current = await readFile(abs).catch(() => null);
      const ok = opts.ifMatch === null ? !current : !!current && etagOf(current) === opts.ifMatch;
      if (!ok) throw new CloudConflict();
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
    return { etag: etagOf(Buffer.from(data)) };
  }

  async upload(p: string, absFile: string) {
    const abs = this.#abs(p);
    await mkdir(path.dirname(abs), { recursive: true });
    await copyFile(absFile, abs);
  }

  async download(p: string, absFile: string) {
    const abs = this.#abs(p);
    if (!(await stat(abs).catch(() => null))?.isFile()) return false;
    await mkdir(path.dirname(absFile), { recursive: true });
    await copyFile(abs, absFile);
    return true;
  }

  async remove(p: string) {
    await rm(this.#abs(p), { recursive: true, force: true });
  }

  async listFolders() {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }
}

function etagOf(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
