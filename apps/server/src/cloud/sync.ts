import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import type { CloudFolderStatus } from '@ide/shared';
import { ensureFolderData, folderDataPath } from '../folderData.js';
import { fileKind, isHiddenName, toRelPosix } from '../paths.js';
import { readFolderSettings } from '../settings.js';
import { CloudAuthError, CloudConflict, type CloudDrive } from './drive.js';

/**
 * Đồng bộ một thư mục làm việc lên ổ đám mây, mỗi khi có bản lưu mới. Trên ổ:
 *   <tên>/…                         bản mới nhất của các file (file thường, mở xem được trên điện thoại)
 *   <tên>/.vsscience/manifest.json  bản kê: mã nội dung từng file, bản lưu mới nhất, các gói lịch sử
 *   <tên>/.vsscience/history/*.pack lịch sử bản lưu (gói git, mỗi lần đồng bộ một gói phần mới)
 *   <tên>/.vsscience/sessions|artifacts|settings.json  đoạn chat, artifact, cài đặt của thư mục
 * Máy khác đã đồng bộ bản mới hơn: lấy về trước (gộp nếu cả hai cùng sửa) rồi mới đẩy lên; không ghi đè.
 */

export const MANIFEST = '.vsscience/manifest.json';

interface Entry {
  sha1: string;
  size: number;
}

export interface Manifest {
  version: 1;
  folderId: string;
  name: string;
  /** Bản lưu mới nhất đã đẩy lên. */
  head: string | null;
  /** Các gói lịch sử, theo thứ tự (trong .vsscience/history/). */
  packs: string[];
  files: Record<string, Entry>;
  /** Dữ liệu của app (đường dẫn tính từ .vsscience/). */
  data: Record<string, Entry>;
  updatedAt: number;
  device: string;
}

/** Trạng thái riêng của máy này (không đồng bộ): lần đồng bộ trước, mã nội dung đã tính. */
interface DeviceState {
  /** Bản lưu mới nhất trên ổ ở lần đồng bộ trước (gốc chung khi gộp). */
  remoteHead: string | null;
  hashes: Record<string, { mtime: number; size: number; sha1: string }>;
  lastSync?: number;
  /** Các gói lịch sử đã có trong kho trên máy. */
  packs?: string[];
  /** Mã nội dung từng file ở lần đồng bộ trước (biết file nào máy này đã sửa từ đó). */
  synced?: Record<string, string>;
}

export interface SnapshotsSource {
  headOid(): Promise<string | null>;
  packSince(since: string | null): Promise<{ head: string; pack: Uint8Array } | null>;
  snapshot(message: string): Promise<boolean>;
  importPacks(packs: { name: string; data: Uint8Array }[]): Promise<void>;
  fastForward(oid: string): Promise<void>;
  changedPaths(a: string, b: string): Promise<Map<string, string | null>>;
  readBlob(oid: string): Promise<Uint8Array>;
  hasPath(commit: string, filepath: string): Promise<boolean>;
  commitMerge(message: string, theirs: string): Promise<void>;
}

const DATA_PARTS = ['sessions', 'artifacts', 'settings.json'];

async function readManifest(drive: CloudDrive, remoteName: string) {
  const remote = await drive.read(`${remoteName}/${MANIFEST}`);
  return remote ? { manifest: JSON.parse(remote.data.toString('utf8')) as Manifest, etag: remote.etag } : null;
}

/** "Đề thi.docx" → "Đề thi (máy Laptop-B).docx" — bản của máy kia khi hai máy cùng sửa một file. */
export function conflictName(rel: string, device: string): string {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  const name = rel.slice(dir.length);
  const dot = name.lastIndexOf('.');
  const tag = ` (máy ${device.replace(/[\\/:*?"<>|]/g, '_')})`;
  return dot > 0 ? `${dir}${name.slice(0, dot)}${tag}${name.slice(dot)}` : `${dir}${name}${tag}`;
}

export class FolderSync {
  #status: CloudFolderStatus = { state: 'idle' };
  #queue: Promise<void> = Promise.resolve();
  #pushPending = false;

  constructor(
    private readonly opts: {
      root: () => string;
      /** Ổ của nhà cung cấp đã kết nối trên máy này; null nếu chưa kết nối. */
      drive: (provider: string) => Promise<CloudDrive | null>;
      snapshots: SnapshotsSource;
      /** File trạng thái riêng của máy cho một thư mục đồng bộ. */
      statePath: (folderId: string) => string;
      onStatus: (s: CloudFolderStatus) => void;
      /** Được lấy bản từ máy khác về lúc này không (không khi Claude đang sửa file). */
      canPull?: () => boolean;
      device?: string;
    },
  ) {}

  get #device() {
    return this.opts.device ?? hostname();
  }

  status(): CloudFolderStatus {
    return this.#status;
  }

  #set(patch: Partial<CloudFolderStatus>) {
    this.#status = { ...this.#status, ...patch };
    this.opts.onStatus(this.#status);
  }

  /** Thư mục đổi: trạng thái về ban đầu. */
  reset() {
    this.#status = { state: 'idle' };
    this.opts.onStatus(this.#status);
  }

  #enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(fn).catch((err) => this.#set({ state: 'error', error: messageOf(err), progress: undefined }));
    this.#queue = run;
    return run;
  }

  /** Đẩy lên (lấy bản mới của máy khác về trước nếu có). Nhiều lần gọi dồn lại thành một. */
  push(): Promise<void> {
    if (this.#pushPending) return this.#queue;
    this.#pushPending = true;
    return this.#enqueue(async () => {
      this.#pushPending = false;
      await this.#sync(true);
    });
  }

  /** Chỉ lấy bản mới của máy khác về (khi mở thư mục, định kỳ). Không đẩy thay đổi chưa lưu bản. */
  pull(): Promise<void> {
    return this.#enqueue(() => this.#sync(false));
  }

  async #sync(push: boolean) {
    const root = this.opts.root();
    const cfg = readFolderSettings(root).cloud;
    if (!cfg) return;
    const drive = await this.opts.drive(cfg.provider);
    if (!drive) {
      this.#set({ state: 'error', error: 'Chưa kết nối tài khoản đám mây trên máy này' });
      return;
    }
    const statePath = this.opts.statePath(cfg.folderId);
    const state = await readState(statePath);
    const R = cfg.remoteName;
    const remote = await readManifest(drive, R);
    if (remote && remote.manifest.folderId !== cfg.folderId) throw new Error(`Trên ổ đã có một thư mục khác tên «${R}»`);

    let merged = false;
    if (remote && remote.manifest.head !== state.remoteHead) {
      if (this.opts.canPull?.() === false) {
        this.#set({ state: 'behind', progress: undefined, remoteDevice: remote.manifest.device, remoteTime: remote.manifest.updatedAt });
        return;
      }
      this.#set({ state: 'syncing', error: undefined, progress: undefined });
      merged = await this.#pull(root, drive, R, remote.manifest, state);
      await writeState(statePath, state);
    }
    if (!push && !merged) {
      if (remote) this.#set({ state: 'synced', lastSync: state.lastSync ?? remote.manifest.updatedAt, progress: undefined, error: undefined });
      return;
    }
    this.#set({ state: 'syncing', error: undefined, progress: undefined });
    await this.#push(root, drive, R, cfg.folderId, remote, state, statePath);
  }

  /**
   * Lấy bản mới của máy khác về. Máy này chưa sửa gì từ lần đồng bộ trước: lấy nhanh (đưa thư mục về bản đó).
   * Có sửa: lưu bản trước, rồi gộp — file chỉ một bên đổi lấy bên đó; cả hai cùng đổi thì giữ bản máy này,
   * bản máy kia ghi thành "tên (máy X).đuôi". Trả về true nếu đã gộp (cần đẩy bản gộp lên).
   */
  async #pull(root: string, drive: CloudDrive, R: string, manifest: Manifest, state: DeviceState): Promise<boolean> {
    const snaps = this.opts.snapshots;
    const device = manifest.device;
    const known = new Set(state.packs ?? []);
    const missing = manifest.packs.filter((n) => !known.has(n));
    const packs: { name: string; data: Uint8Array }[] = [];
    for (const name of missing) {
      const r = await drive.read(`${R}/.vsscience/history/${name}`);
      if (r) packs.push({ name, data: r.data });
    }
    if (packs.length) await snaps.importPacks(packs);

    await snaps.snapshot(`Trước khi lấy bản từ máy «${device}»`);
    const ours = await snaps.headOid();
    const theirs = manifest.head;
    const base = state.remoteHead;
    let merged = false;
    const write = async (rel: string, oid: string | null) => {
      const abs = path.join(root, ...rel.split('/'));
      if (oid === null) return void (await rm(abs, { force: true }));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, await snaps.readBlob(oid));
    };

    if (theirs && ours !== theirs) {
      if (ours && base === ours) {
        await snaps.fastForward(theirs);
      } else if (ours) {
        const oursCh = base ? await snaps.changedPaths(base, ours) : null;
        const theirsCh = await snaps.changedPaths(base ?? ours, theirs);
        for (const [rel, oid] of theirsCh) {
          // Không có gốc chung (máy này bật đồng bộ độc lập): coi mọi khác biệt là cả hai cùng sửa.
          const oursChanged = oursCh ? oursCh.has(rel) : await snaps.hasPath(ours, rel);
          if (!oursChanged) await write(rel, oid);
          else if (oid !== null && (!oursCh || oursCh.get(rel) !== oid)) await write(conflictName(rel, device), oid);
        }
        await snaps.commitMerge(`Gộp thay đổi từ máy «${device}»`, theirs);
        merged = true;
      } else {
        await snaps.fastForward(theirs);
      }
    }

    // File không nằm trong bản lưu (quá lớn): theo bản kê.
    const local = await hashAll(await listFiles(root), state.hashes, (state.hashes = { ...state.hashes }), 'f:');
    for (const [rel, e] of Object.entries(manifest.files)) {
      if (local[rel]?.sha1 === e.sha1 || (theirs && (await snaps.hasPath(theirs, rel)))) continue;
      const changedHere = !!local[rel] && state.synced?.[rel] !== local[rel]!.sha1;
      await drive.download(`${R}/${rel}`, path.join(root, ...(changedHere ? conflictName(rel, device) : rel).split('/')));
    }
    for (const [rel, sha1] of Object.entries(state.synced ?? {})) {
      if (manifest.files[rel] || local[rel]?.sha1 !== sha1) continue;
      if (theirs && (await snaps.hasPath(theirs, rel))) continue;
      await rm(path.join(root, ...rel.split('/')), { force: true });
    }
    // Đoạn chat, artifact, cài đặt: lấy bản trên ổ; đoạn chat trên máy này dài hơn (đang viết tiếp) thì giữ.
    const data = await hashAll(await listData(root), {}, {}, 'd:');
    for (const [rel, e] of Object.entries(manifest.data)) {
      if (data[rel]?.sha1 === e.sha1) continue;
      if (rel.startsWith('sessions/') && (data[rel]?.size ?? 0) > e.size) continue;
      await drive.download(`${R}/.vsscience/${rel}`, folderDataPath(root, ...rel.split('/')));
    }

    state.remoteHead = theirs;
    state.packs = [...manifest.packs];
    state.synced = Object.fromEntries(Object.entries(manifest.files).map(([rel, e]) => [rel, e.sha1]));
    state.lastSync = Date.now();
    return merged;
  }

  async #push(
    root: string,
    drive: CloudDrive,
    R: string,
    folderId: string,
    remote: { manifest: Manifest; etag: string } | null,
    state: DeviceState,
    statePath: string,
  ) {
    const manifest = remote?.manifest ?? null;
    // Mã nội dung tính lại chỉ khi file đổi (thời gian sửa, cỡ); bỏ mục của file đã xóa.
    const prevHashes = state.hashes;
    state.hashes = {};
    const files = await hashAll(await listFiles(root), prevHashes, state.hashes, 'f:');
    const data = await hashAll(await listData(root), prevHashes, state.hashes, 'd:');
    const pack = await this.opts.snapshots.packSince(manifest?.head ?? null);

    const upFiles = Object.entries(files).filter(([rel, f]) => manifest?.files[rel]?.sha1 !== f.sha1);
    const upData = Object.entries(data).filter(([rel, f]) => manifest?.data[rel]?.sha1 !== f.sha1);
    const goneFiles = Object.keys(manifest?.files ?? {}).filter((rel) => !files[rel]);
    const goneData = Object.keys(manifest?.data ?? {}).filter((rel) => !data[rel]);
    const total = upFiles.length + upData.length + goneFiles.length + goneData.length + (pack ? 1 : 0);
    let done = 0;
    const step = () => this.#set({ progress: { done: ++done, total } });
    this.#set({ progress: { done, total } });

    const next: Manifest = {
      version: 1,
      folderId,
      name: path.basename(root),
      head: manifest?.head ?? null,
      packs: [...(manifest?.packs ?? [])],
      files: { ...(manifest?.files ?? {}) },
      data: { ...(manifest?.data ?? {}) },
      updatedAt: Date.now(),
      device: this.#device,
    };
    const failed: string[] = [];
    const attempt = async (rel: string, fn: () => Promise<void>) => {
      try {
        await fn();
        return true;
      } catch (err) {
        if (err instanceof CloudAuthError) throw err;
        failed.push(rel);
        return false;
      } finally {
        step();
      }
    };

    if (pack) {
      const name = `${String(next.packs.length + 1).padStart(4, '0')}-${pack.head.slice(0, 12)}.pack`;
      await drive.write(`${R}/.vsscience/history/${name}`, pack.pack);
      next.packs.push(name);
      next.head = pack.head;
      step();
    }
    for (const [rel, f] of upFiles) {
      if (await attempt(rel, () => drive.upload(`${R}/${rel}`, path.join(root, ...rel.split('/'))))) next.files[rel] = { sha1: f.sha1, size: f.size };
    }
    for (const [rel, f] of upData) {
      if (await attempt(rel, () => drive.upload(`${R}/.vsscience/${rel}`, folderDataPath(root, ...rel.split('/'))))) next.data[rel] = { sha1: f.sha1, size: f.size };
    }
    for (const rel of goneFiles) if (await attempt(rel, () => drive.remove(`${R}/${rel}`))) delete next.files[rel];
    for (const rel of goneData) if (await attempt(rel, () => drive.remove(`${R}/.vsscience/${rel}`))) delete next.data[rel];

    try {
      await drive.write(`${R}/${MANIFEST}`, Buffer.from(JSON.stringify(next, null, 1)), { ifMatch: remote?.etag ?? null });
    } catch (err) {
      if (err instanceof CloudConflict) {
        // Máy khác vừa đẩy lên trong lúc này: lần sau sẽ lấy bản đó về rồi đẩy lại.
        this.#set({ state: 'behind', progress: undefined });
        return;
      }
      throw err;
    }
    state.remoteHead = next.head;
    state.packs = [...next.packs];
    state.synced = Object.fromEntries(Object.entries(next.files).map(([rel, e]) => [rel, e.sha1]));
    state.lastSync = next.updatedAt;
    await writeState(statePath, state);
    this.#set({
      state: failed.length ? 'error' : 'synced',
      lastSync: next.updatedAt,
      progress: undefined,
      error: failed.length ? `${failed.length} file chưa tải lên được (ví dụ: ${failed.slice(0, 2).join(', ')})` : undefined,
    });
  }
}

/** Một thư mục đã đồng bộ trên ổ (để tải về máy khác). */
export interface RemoteFolder {
  name: string;
  folderId: string;
  device: string;
  updatedAt: number;
  files: number;
  bytes: number;
}

export async function listRemoteFolders(drive: CloudDrive): Promise<RemoteFolder[]> {
  const out: RemoteFolder[] = [];
  for (const name of await drive.listFolders()) {
    const r = await readManifest(drive, name).catch(() => null);
    if (!r) continue;
    const entries = Object.values(r.manifest.files);
    out.push({
      name,
      folderId: r.manifest.folderId,
      device: r.manifest.device,
      updatedAt: r.manifest.updatedAt,
      files: entries.length,
      bytes: entries.reduce((n, e) => n + e.size, 0),
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Tải một thư mục đã đồng bộ về máy này, vào `target` (chưa có hoặc đang trống): dựng lại lịch sử bản lưu
 * từ các gói, ghi các file, tải file lớn và dữ liệu của app (đoạn chat, artifact, cài đặt — đã bật đồng bộ sẵn).
 */
export async function cloneFolder(opts: {
  drive: CloudDrive;
  remoteName: string;
  target: string;
  statePath: (folderId: string) => string;
  restoreHistory: (root: string, packs: { name: string; data: Uint8Array }[], head: string) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}): Promise<void> {
  const { drive, remoteName: R, target } = opts;
  const remote = await readManifest(drive, R);
  if (!remote) throw new Error(`Không thấy thư mục «${R}» trên ổ`);
  const m = remote.manifest;
  const existing = await readdir(target).catch(() => null);
  if (existing && existing.length) throw new Error(`Thư mục «${target}» đã có sẵn và không trống`);
  await mkdir(target, { recursive: true });
  await ensureFolderData(target);

  const total = m.packs.length + Object.keys(m.files).length + Object.keys(m.data).length;
  let done = 0;
  const step = () => opts.onProgress?.(++done, total);
  opts.onProgress?.(0, total);

  const packs: { name: string; data: Uint8Array }[] = [];
  for (const name of m.packs) {
    const r = await drive.read(`${R}/.vsscience/history/${name}`);
    if (r) packs.push({ name, data: r.data });
    step();
  }
  if (m.head) await opts.restoreHistory(target, packs, m.head);
  // Các file đã có từ lịch sử bản lưu; chỉ tải những file khác bản kê (file lớn ngoài bản lưu…).
  const hashes: DeviceState['hashes'] = {};
  const local = await hashAll(await listFiles(target), {}, hashes, 'f:');
  for (const [rel, e] of Object.entries(m.files)) {
    if (local[rel]?.sha1 !== e.sha1) await drive.download(`${R}/${rel}`, path.join(target, ...rel.split('/')));
    step();
  }
  for (const rel of Object.keys(m.data)) {
    await drive.download(`${R}/.vsscience/${rel}`, folderDataPath(target, ...rel.split('/')));
    step();
  }
  const state: DeviceState = {
    remoteHead: m.head,
    hashes: {},
    packs: [...m.packs],
    synced: Object.fromEntries(Object.entries(m.files).map(([rel, e]) => [rel, e.sha1])),
    lastSync: Date.now(),
  };
  await writeState(opts.statePath(m.folderId), state);
}

function messageOf(err: unknown): string {
  return (err as Error)?.message || String(err);
}

async function readState(file: string): Promise<DeviceState> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<DeviceState>;
    return { remoteHead: raw.remoteHead ?? null, hashes: raw.hashes ?? {}, lastSync: raw.lastSync };
  } catch {
    return { remoteHead: null, hashes: {} };
  }
}

async function writeState(file: string, state: DeviceState) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state));
}

interface LocalFile {
  rel: string;
  abs: string;
  size: number;
  mtime: number;
}

/** File của người dùng được đồng bộ: tài liệu, ghi chú, ảnh… như bản lưu (không zip, video, file chạy…), bỏ file/thư mục ẩn; kể cả file lớn hơn giới hạn của bản lưu. */
export async function listFiles(root: string): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (isHiddenName(e.name) || e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && fileKind(e.name) !== 'other') {
        const st = await stat(abs).catch(() => null);
        if (st) out.push({ rel: toRelPosix(root, abs).normalize('NFC'), abs, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  await walk(root);
  return out;
}

/** Dữ liệu của app trong .vsscience cần đồng bộ (không gồm lịch sử bản lưu — đi theo gói riêng). */
async function listData(root: string): Promise<LocalFile[]> {
  const base = folderDataPath(root);
  const out: LocalFile[] = [];
  const add = async (abs: string) => {
    const st = await stat(abs).catch(() => null);
    if (!st) return;
    if (st.isDirectory()) {
      for (const name of await readdir(abs).catch(() => [])) await add(path.join(abs, name));
    } else if (st.isFile()) {
      out.push({ rel: toRelPosix(base, abs), abs, size: st.size, mtime: st.mtimeMs });
    }
  };
  for (const part of DATA_PARTS) await add(path.join(base, part));
  return out;
}

async function hashAll(list: LocalFile[], prev: DeviceState['hashes'], next: DeviceState['hashes'], prefix: string): Promise<Record<string, Entry>> {
  const out: Record<string, Entry> = {};
  for (const f of list) {
    const key = prefix + f.rel;
    const cached = prev[key];
    const sha1 = cached && cached.mtime === f.mtime && cached.size === f.size ? cached.sha1 : await sha1File(f.abs);
    next[key] = { mtime: f.mtime, size: f.size, sha1 };
    out[f.rel] = { sha1, size: f.size };
  }
  return out;
}

function sha1File(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha1');
    createReadStream(abs)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}
