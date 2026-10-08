import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactInfo } from '@ide/shared';

/** Link trang Claude đăng (claude.ai/artifact/… hoặc claude.ai/code/artifact/…), lấy từ kết quả công cụ Artifact. */
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;

export function artifactUrl(output: string): string | null {
  return ARTIFACT_URL.exec(output)?.[0] ?? null;
}

/** Tiêu đề trang: thẻ <title> trong HTML, nếu không có thì tên file. */
export function artifactTitle(html: string, filePath: string, given?: string): string {
  const tag = /<title[^>]*>([^<]*)<\/title>/i.exec(html.slice(0, 16_384))?.[1]?.trim();
  return tag || given?.trim() || path.basename(filePath).replace(/\.[^.]+$/, '');
}

interface Index {
  items: ArtifactInfo[];
  /** Đã quét lịch sử các phiên cũ để lấy lại file Claude từng tạo. */
  backfilled?: boolean;
}

/**
 * Sản phẩm Claude tạo ra khi làm việc với từng thư mục:
 * - file mới trong thư mục làm việc (ghi chú .md, đề .docx, bảng .xlsx…): chỉ lưu đường dẫn, xem bằng khung xem file;
 *   file đã bị xóa thì tự rời khỏi danh sách.
 * - trang đăng lên claude.ai (công cụ Artifact): lưu bản sao HTML để xem lại trong app.
 * Nằm trong thư mục dữ liệu của app, mỗi thư mục làm việc một thư mục con (theo mã băm đường dẫn).
 */
export class ArtifactStore {
  constructor(private readonly dir: string) {}

  #folder(cwd: string): string {
    return path.join(this.dir, createHash('sha1').update(cwd).digest('hex').slice(0, 12));
  }

  async #load(cwd: string): Promise<Index> {
    try {
      const raw = JSON.parse(await readFile(path.join(this.#folder(cwd), 'index.json'), 'utf8')) as Index | ArtifactInfo[];
      const index = Array.isArray(raw) ? { items: raw } : raw;
      // Bản cũ chỉ có trang đã đăng.
      index.items = index.items.map((a) => ({ ...a, source: a.source ?? 'published' }));
      return index;
    } catch {
      return { items: [] };
    }
  }

  async #save(cwd: string, index: Index) {
    await mkdir(this.#folder(cwd), { recursive: true });
    await writeFile(path.join(this.#folder(cwd), 'index.json'), JSON.stringify(index, null, 2));
  }

  /** Mới nhất trước; file đã bị xóa khỏi thư mục thì không hiện. */
  async list(cwd: string): Promise<ArtifactInfo[]> {
    const { items } = await this.#load(cwd);
    return items
      .filter((a) => a.source !== 'file' || (a.path && existsSync(path.join(cwd, a.path))))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Ghi nhận một lần đăng trang. Đăng lại cùng link (sửa trang) thì cập nhật mục cũ thay vì thêm mục mới. */
  async record(
    cwd: string,
    entry: { title: string; description?: string; url: string | null; fileName: string; html: string },
  ): Promise<ArtifactInfo> {
    const index = await this.#load(cwd);
    const now = Date.now();
    const existing = entry.url ? index.items.find((a) => a.url === entry.url) : undefined;
    const info: ArtifactInfo = existing
      ? { ...existing, title: entry.title, description: entry.description ?? existing.description, fileName: entry.fileName, updatedAt: now }
      : {
          id: randomUUID(),
          source: 'published',
          title: entry.title,
          description: entry.description,
          url: entry.url,
          fileName: entry.fileName,
          createdAt: now,
          updatedAt: now,
        };
    await mkdir(this.#folder(cwd), { recursive: true });
    await writeFile(path.join(this.#folder(cwd), `${info.id}.html`), entry.html);
    await this.#save(cwd, { ...index, items: [info, ...index.items.filter((a) => a.id !== info.id)] });
    return info;
  }

  /** Ghi nhận các file Claude vừa tạo trong thư mục (đường dẫn tương đối, dạng /). Trả về true nếu có mục mới. */
  async recordFiles(cwd: string, files: { path: string; time?: number }[]): Promise<boolean> {
    if (files.length === 0) return false;
    const index = await this.#load(cwd);
    const known = new Set(index.items.filter((a) => a.source === 'file').map((a) => a.path));
    const added: ArtifactInfo[] = [];
    for (const f of files) {
      if (known.has(f.path)) continue;
      known.add(f.path);
      const time = f.time ?? Date.now();
      added.push({ id: randomUUID(), source: 'file', path: f.path, title: path.posix.basename(f.path), url: null, fileName: path.posix.basename(f.path), createdAt: time, updatedAt: time });
    }
    if (added.length === 0) return false;
    await this.#save(cwd, { ...index, items: [...added, ...index.items] });
    return true;
  }

  /**
   * Lần đầu mở danh sách của một thư mục: lấy lại các file Claude từng tạo trong các phiên trước
   * (trước khi có tính năng này). Chỉ chạy một lần cho mỗi thư mục.
   */
  async backfill(cwd: string, find: () => Promise<string[]>): Promise<boolean> {
    const index = await this.#load(cwd);
    if (index.backfilled) return false;
    let paths: string[] = [];
    try {
      paths = await find();
    } catch {
      // không đọc được lịch sử: bỏ qua, vẫn đánh dấu để không quét lại mãi
    }
    const files: { path: string; time?: number }[] = [];
    for (const p of paths) {
      const st = await stat(path.join(cwd, p)).catch(() => null);
      if (st?.isFile()) files.push({ path: p, time: st.mtimeMs });
    }
    await this.#save(cwd, { ...index, backfilled: true });
    return this.recordFiles(cwd, files);
  }

  async content(cwd: string, id: string): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    try {
      return await readFile(path.join(this.#folder(cwd), `${id}.html`), 'utf8');
    } catch {
      return null;
    }
  }

  /** Bỏ khỏi danh sách trong app (file trong thư mục và trang trên claude.ai vẫn còn). */
  async remove(cwd: string, id: string): Promise<void> {
    const index = await this.#load(cwd);
    if (!index.items.some((a) => a.id === id)) return;
    await rm(path.join(this.#folder(cwd), `${id}.html`), { force: true });
    await this.#save(cwd, { ...index, items: index.items.filter((a) => a.id !== id) });
  }
}

/**
 * Các file Claude từng tạo mới (công cụ Write báo "File created") trong thư mục làm việc, đọc từ lịch sử phiên.
 * `messages` là nội dung các phiên (định dạng tin nhắn của Claude Code).
 */
export function createdFilesFromMessages(cwd: string, messages: unknown[]): string[] {
  const pending = new Map<string, string>();
  const created: string[] = [];
  for (const m of messages) {
    const content = (m as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Record<string, unknown>[]) {
      if (b.type === 'tool_use' && b.name === 'Write') {
        const fp = (b.input as { file_path?: unknown } | undefined)?.file_path;
        if (typeof fp === 'string') pending.set(String(b.id), fp);
      } else if (b.type === 'tool_result' && pending.has(String(b.tool_use_id)) && !b.is_error) {
        const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        const abs = path.resolve(cwd, pending.get(String(b.tool_use_id))!);
        const rel = path.relative(cwd, abs);
        if (/created successfully/i.test(out) && rel && !rel.startsWith('..') && !path.isAbsolute(rel)) created.push(rel.split(path.sep).join('/'));
      }
    }
  }
  return created;
}
