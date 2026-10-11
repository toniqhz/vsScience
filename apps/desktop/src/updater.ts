/**
 * Cập nhật app từ GitHub Releases.
 *   Windows: electron-updater tải ngầm bản mới (chỉ phần thay đổi nhờ blockmap), cài khi khởi động lại app.
 *   macOS: chưa ký Apple Developer ID nên không tự thay app được — chỉ báo có bản mới kèm link tải bộ cài.
 */
import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateInfo } from '@ide/shared';

const OWNER = 'toniqhz';
const REPO = 'vsScience';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

type Listener = (u: UpdateInfo) => void;

/** So phiên bản dạng 1.2.3 (bỏ "v" ở đầu); > 0 nếu a mới hơn b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function installerUrl(): string {
  const file = process.platform === 'win32' ? 'VsScience-win-x64.exe' : `VsScience-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
  return `https://github.com/${OWNER}/${REPO}/releases/latest/download/${file}`;
}

/** Bản phát hành mới nhất trên GitHub (không cần đăng nhập). */
async function latestRelease(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'VsScience' },
  });
  if (!res.ok) throw new Error(`GitHub trả lỗi ${res.status}`);
  const tag = ((await res.json()) as { tag_name?: string }).tag_name;
  if (!tag) throw new Error('Không đọc được phiên bản mới nhất');
  return tag.replace(/^v/, '');
}

export class Updater {
  #info: UpdateInfo = { state: 'idle', current: app.getVersion(), canInstall: false };
  #listeners = new Set<Listener>();
  #auto = process.platform === 'win32' && app.isPackaged;
  #timer: NodeJS.Timeout | undefined;

  constructor() {
    // Thử khi phát triển: IDE_UPDATE_DEV_VERSION=0.1.0 giả làm bản đã cài là 0.1.0 và hỏi GitHub thật (như trên Mac).
    const devVersion = !app.isPackaged ? process.env.IDE_UPDATE_DEV_VERSION : undefined;
    if (devVersion) {
      this.#info = { ...this.#info, current: devVersion };
      return;
    }
    if (!app.isPackaged) {
      this.#info = { ...this.#info, state: 'unsupported', error: 'Bản chạy thử từ mã nguồn không tự cập nhật.' };
      return;
    }
    if (this.#auto) this.#wireAutoUpdater();
  }

  #set(patch: Partial<UpdateInfo>) {
    this.#info = { ...this.#info, ...patch };
    for (const fn of this.#listeners) fn(this.#info);
  }

  #wireAutoUpdater() {
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => this.#set({ state: 'checking', error: undefined }));
    autoUpdater.on('update-not-available', () => this.#set({ state: 'none', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => this.#set({ state: 'downloading', latest: info.version, progress: 0, checkedAt: Date.now() }));
    autoUpdater.on('download-progress', (p) => this.#set({ state: 'downloading', progress: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => this.#set({ state: 'ready', latest: info.version, progress: 100, canInstall: true }));
    autoUpdater.on('error', (err) => void this.#fallback(err));
  }

  /** Tự cập nhật lỗi (mạng, bản cũ chưa có latest.yml…): vẫn báo có bản mới kèm link tải bộ cài. */
  async #fallback(err: unknown) {
    if (this.#info.state === 'ready') return;
    try {
      const latest = await latestRelease();
      if (compareVersions(latest, this.#info.current) > 0) {
        this.#set({ state: 'available', latest, canInstall: false, downloadUrl: installerUrl(), checkedAt: Date.now(), error: undefined });
        return;
      }
      this.#set({ state: 'none', latest, checkedAt: Date.now(), error: undefined });
    } catch {
      this.#set({ state: 'error', error: (err as Error)?.message || 'Không kiểm tra được bản mới' });
    }
  }

  status(): UpdateInfo {
    return this.#info;
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  async check(): Promise<UpdateInfo> {
    if (this.#info.state === 'unsupported' || this.#info.state === 'ready' || this.#info.state === 'downloading') return this.#info;
    if (this.#auto) {
      try {
        await electronUpdater.autoUpdater.checkForUpdates();
      } catch (err) {
        await this.#fallback(err);
      }
      return this.#info;
    }
    this.#set({ state: 'checking', error: undefined });
    try {
      const latest = await latestRelease();
      const newer = compareVersions(latest, this.#info.current) > 0;
      this.#set({ state: newer ? 'available' : 'none', latest, downloadUrl: newer ? installerUrl() : undefined, checkedAt: Date.now() });
    } catch (err) {
      this.#set({ state: 'error', error: (err as Error)?.message || 'Không kiểm tra được bản mới' });
    }
    return this.#info;
  }

  /** Thoát và cài bản đã tải (Windows): cài lặng lẽ rồi tự mở lại app. */
  install() {
    if (this.#auto && this.#info.canInstall) electronUpdater.autoUpdater.quitAndInstall(true, true);
  }

  /** Kiểm tra lúc mở app (sau một lúc cho app khởi động xong) và định kỳ. */
  start() {
    if (this.#info.state === 'unsupported') return;
    setTimeout(() => void this.check(), 15_000);
    this.#timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.#timer.unref();
  }
}
