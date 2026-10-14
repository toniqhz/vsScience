import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CloudProviderId, CloudProviderInfo } from '@ide/shared';
import { CloudAuthError, LocalDrive, type CloudDrive } from './drive.js';
import { OneDriveDrive, microsoftProfile, oneDriveClientId, refreshMicrosoft, startMicrosoftLogin, type MsTokens } from './onedrive.js';

/** Mã hóa mã đăng nhập (app desktop dùng kho bảo mật của hệ điều hành). */
export interface SecretBox {
  encrypt(text: string): string;
  decrypt(text: string): string;
}

interface SavedAccount {
  account: { name: string; email?: string };
  /** Mã làm mới (đã mã hóa nếu có SecretBox). */
  refresh: string;
  encrypted: boolean;
}

/**
 * Tài khoản đám mây đã kết nối trên máy này (mỗi máy đăng nhập riêng; không đồng bộ).
 * Lưu trong thư mục dữ liệu của app: <dir>/<nhà cung cấp>.json.
 */
export class CloudAccounts {
  #access = new Map<CloudProviderId, { token: string; expiresAt: number }>();
  #login: { provider: CloudProviderId; cancel: () => void } | null = null;

  constructor(
    private readonly opts: {
      dir: string;
      secrets?: SecretBox;
      /** Ổ thử nghiệm (một thư mục trên máy) — khi chạy thử hoặc test. */
      localDriveDir?: string;
      onChange: () => void;
    },
  ) {}

  get connecting(): CloudProviderId | undefined {
    return this.#login?.provider;
  }

  #file(id: CloudProviderId) {
    return path.join(this.opts.dir, `${id}.json`);
  }

  async #saved(id: CloudProviderId): Promise<SavedAccount | null> {
    try {
      return JSON.parse(await readFile(this.#file(id), 'utf8')) as SavedAccount;
    } catch {
      return null;
    }
  }

  async #save(id: CloudProviderId, account: SavedAccount['account'], refresh: string) {
    const secrets = this.opts.secrets;
    const saved: SavedAccount = { account, refresh: secrets ? secrets.encrypt(refresh) : refresh, encrypted: !!secrets };
    await mkdir(this.opts.dir, { recursive: true });
    await writeFile(this.#file(id), JSON.stringify(saved, null, 2), { mode: 0o600 });
  }

  async providers(): Promise<CloudProviderInfo[]> {
    const one = await this.#saved('onedrive');
    const list: CloudProviderInfo[] = [
      {
        id: 'onedrive',
        name: 'OneDrive',
        available: !!oneDriveClientId(),
        ...(oneDriveClientId() ? {} : { note: 'Bản này chưa được cấu hình OneDrive (thiếu client ID).' }),
        account: one?.account ?? null,
      },
      { id: 'gdrive', name: 'Google Drive', available: false, note: 'Sắp có.', account: null },
    ];
    if (this.opts.localDriveDir) {
      list.push({ id: 'local', name: 'Ổ thử nghiệm', available: true, note: this.opts.localDriveDir, account: (await this.#saved('local'))?.account ?? null });
    }
    return list;
  }

  /** Bắt đầu kết nối: trả về trang đăng nhập cần mở trong trình duyệt (ổ thử nghiệm thì kết nối ngay). */
  async connect(id: CloudProviderId): Promise<{ url?: string }> {
    if (id === 'local') {
      if (!this.opts.localDriveDir) throw new Error('Không có ổ thử nghiệm');
      await this.#save('local', { name: 'Thử nghiệm' }, '-');
      this.opts.onChange();
      return {};
    }
    if (id !== 'onedrive') throw new Error('Chưa hỗ trợ nhà cung cấp này');
    const clientId = oneDriveClientId();
    if (!clientId) throw new Error('Bản này chưa được cấu hình OneDrive (thiếu client ID)');
    this.#login?.cancel();
    const login = await startMicrosoftLogin(clientId);
    this.#login = { provider: id, cancel: login.cancel };
    this.opts.onChange();
    void login.done
      .then(async (tokens) => {
        const account = await microsoftProfile(tokens.accessToken);
        await this.#save('onedrive', account, tokens.refreshToken);
        this.#access.set('onedrive', { token: tokens.accessToken, expiresAt: tokens.expiresAt });
      })
      .catch(() => {})
      .finally(() => {
        if (this.#login?.cancel === login.cancel) this.#login = null;
        this.opts.onChange();
      });
    return { url: login.url };
  }

  cancelConnect() {
    this.#login?.cancel();
  }

  async disconnect(id: CloudProviderId) {
    this.#access.delete(id);
    await rm(this.#file(id), { force: true });
    this.opts.onChange();
  }

  /** Mã truy cập còn hạn (tự làm mới); lỗi CloudAuthError nếu cần đăng nhập lại. */
  async #token(id: 'onedrive', force = false): Promise<string> {
    const cached = this.#access.get(id);
    if (cached && !force && cached.expiresAt > Date.now()) return cached.token;
    const saved = await this.#saved(id);
    if (!saved) throw new CloudAuthError();
    const refresh = saved.encrypted ? this.opts.secrets?.decrypt(saved.refresh) : saved.refresh;
    if (!refresh) throw new CloudAuthError();
    let tokens: MsTokens;
    try {
      tokens = await refreshMicrosoft(oneDriveClientId(), refresh);
    } catch (err) {
      throw err instanceof CloudAuthError ? new CloudAuthError('Cần kết nối lại OneDrive') : err;
    }
    this.#access.set(id, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
    if (tokens.refreshToken && tokens.refreshToken !== refresh) await this.#save(id, saved.account, tokens.refreshToken);
    return tokens.accessToken;
  }

  /** Ổ của nhà cung cấp đã kết nối trên máy này; null nếu chưa kết nối. */
  async drive(id: CloudProviderId): Promise<CloudDrive | null> {
    if (!(await this.#saved(id))) return null;
    if (id === 'local') return this.opts.localDriveDir ? new LocalDrive(this.opts.localDriveDir) : null;
    if (id === 'onedrive' && oneDriveClientId()) return new OneDriveDrive((force) => this.#token('onedrive', force));
    return null;
  }
}
