import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { importSessionToStore, listSessions, type SessionKey, type SessionStore, type SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { ensureFolderData, exists, folderDataPath } from './folderData.js';

/**
 * Lưu các đoạn chat với Claude ngay trong thư mục làm việc (.vsscience/sessions), thay vì theo đường dẫn
 * thư mục trong ~/.claude: chuyển, đổi tên hay đồng bộ thư mục sang máy khác vẫn mở tiếp được đoạn chat.
 *
 * Mỗi phiên một file JSONL (giống định dạng của Claude Code); phiên của tác tử con nằm trong thư mục cùng tên.
 * Kho này là của riêng một thư mục, nên bỏ qua projectKey (khóa theo đường dẫn) mà SDK truyền vào.
 */
export class FolderSessionStore implements SessionStore {
  /** uuid đã ghi của từng file, để không ghi trùng khi SDK gửi lại. */
  #seen = new Map<string, Set<string>>();
  /** Ghi tuần tự theo từng file. */
  #queue = new Map<string, Promise<void>>();

  constructor(readonly dir: string) {}

  #file(key: Pick<SessionKey, 'sessionId' | 'subpath'>): string {
    const id = safe(key.sessionId);
    if (!key.subpath) return path.join(this.dir, `${id}.jsonl`);
    const parts = key.subpath.split('/').filter(Boolean).map(safe);
    return path.join(this.dir, id, ...parts) + '.jsonl';
  }

  async #seenFor(file: string): Promise<Set<string>> {
    let seen = this.#seen.get(file);
    if (!seen) {
      seen = new Set((await readEntries(file)).map((e) => e.uuid).filter((u): u is string => !!u));
      this.#seen.set(file, seen);
    }
    return seen;
  }

  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const file = this.#file(key);
    const run = (this.#queue.get(file) ?? Promise.resolve()).then(async () => {
      const seen = await this.#seenFor(file);
      const fresh = entries.filter((e) => !e.uuid || !seen.has(e.uuid));
      if (!fresh.length) return;
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, fresh.map((e) => JSON.stringify(e)).join('\n') + '\n');
      for (const e of fresh) if (e.uuid) seen.add(e.uuid);
    });
    this.#queue.set(file, run.catch(() => {}));
    return run;
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const file = this.#file(key);
    await this.#queue.get(file);
    const entries = await readEntries(file);
    return entries.length || (await exists(file)) ? entries : null;
  }

  async listSessions(): Promise<{ sessionId: string; mtime: number }[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const out: { sessionId: string; mtime: number }[] = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const st = await stat(path.join(this.dir, name)).catch(() => null);
      if (st?.isFile()) out.push({ sessionId: name.slice(0, -'.jsonl'.length), mtime: Math.floor(st.mtimeMs) });
    }
    return out;
  }

  async delete(key: SessionKey): Promise<void> {
    const file = this.#file(key);
    await this.#queue.get(file);
    this.#seen.delete(file);
    await rm(file, { force: true });
    if (!key.subpath) await rm(path.join(this.dir, safe(key.sessionId)), { recursive: true, force: true });
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const root = path.join(this.dir, safe(key.sessionId));
    const out: string[] = [];
    const walk = async (dir: string, prefix: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        else if (entry.name.endsWith('.jsonl')) out.push(`${prefix}${entry.name.slice(0, -'.jsonl'.length)}`);
      }
    };
    await walk(root, '');
    return out;
  }

  /** Đã có phiên này trong kho chưa (để chuyển phiên cũ từ ~/.claude sang). */
  has(sessionId: string): Promise<boolean> {
    return exists(this.#file({ sessionId }));
  }
}

/** Tên file an toàn: id phiên của Claude là UUID; chặn mọi ký tự lạ (/, .., …). */
function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Đọc file JSONL; bỏ dòng hỏng (ví dụ dòng ghi dở khi máy tắt đột ngột). */
async function readEntries(file: string): Promise<SessionStoreEntry[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const out: SessionStoreEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SessionStoreEntry);
    } catch {
      // dòng hỏng: bỏ qua
    }
  }
  return out;
}

const stores = new Map<string, Promise<FolderSessionStore | null>>();

/**
 * Kho đoạn chat của một thư mục làm việc; null nếu thư mục không ghi được (dùng kho mặc định của Claude Code).
 * Lần đầu: chuyển các đoạn chat cũ của thư mục này (trong ~/.claude) vào kho — một lần, bản cũ vẫn giữ nguyên.
 */
export function folderSessionStore(root: string): Promise<FolderSessionStore | null> {
  let p = stores.get(root);
  if (!p) {
    p = (async () => {
      if (!(await ensureFolderData(root))) return null;
      const store = new FolderSessionStore(folderDataPath(root, 'sessions'));
      await importLegacySessions(root, store).catch(() => {});
      return store;
    })();
    stores.set(root, p);
  }
  return p;
}

async function importLegacySessions(root: string, store: FolderSessionStore) {
  const marker = path.join(store.dir, '.da-chuyen');
  if (await exists(marker)) return;
  const local = await listSessions({ dir: root, includeProgrammatic: true, limit: 500 }).catch(() => []);
  for (const s of local) {
    if (await store.has(s.sessionId)) continue;
    await importSessionToStore(s.sessionId, store, { dir: root }).catch(() => {});
  }
  await mkdir(store.dir, { recursive: true });
  await writeFile(marker, `Đã chuyển ${local.length} đoạn chat từ Claude Code vào đây.\n`);
}
