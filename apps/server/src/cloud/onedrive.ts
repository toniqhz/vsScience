import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CloudAuthError, CloudConflict, type CloudDrive } from './drive.js';

/**
 * OneDrive qua Microsoft Graph. Quyền xin hẹp nhất: chỉ thư mục riêng của app trên OneDrive của người dùng
 * (Ứng dụng/VsScience — Files.ReadWrite.AppFolder). Đăng nhập bằng trình duyệt (OAuth + PKCE, không cần
 * mật khẩu ứng dụng); client ID là mã công khai của app VsScience đã đăng ký với Microsoft.
 */

/** Client ID của app VsScience (Microsoft Entra). Để trống: OneDrive chưa dùng được trên bản này. */
const BUILT_IN_CLIENT_ID = '42fba828-9582-4e82-a65a-1f93b73946bd';

export function oneDriveClientId(): string {
  return process.env.IDE_ONEDRIVE_CLIENT_ID?.trim() || BUILT_IN_CLIENT_ID;
}

const AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'Files.ReadWrite.AppFolder User.Read offline_access';
/** File nhỏ hơn thế tải lên một lần; lớn hơn thì chia phần (mỗi phần là bội số của 320 KiB). */
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
const CHUNK = 16 * 320 * 1024;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

export interface MsTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function toTokens(r: TokenResponse, previousRefresh?: string): MsTokens {
  if (!r.access_token) throw new CloudAuthError(r.error_description?.split('\n')[0] || r.error || 'Microsoft không trả mã truy cập');
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? previousRefresh ?? '',
    expiresAt: Date.now() + Math.max(60, (r.expires_in ?? 3600) - 120) * 1000,
  };
}

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return (await res.json().catch(() => ({ error: `Lỗi ${res.status}` }))) as TokenResponse;
}

export async function refreshMicrosoft(clientId: string, refreshToken: string): Promise<MsTokens> {
  const r = await tokenRequest({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPES });
  return toTokens(r, refreshToken);
}

export async function microsoftProfile(accessToken: string): Promise<{ name: string; email?: string }> {
  const res = await fetch(`${GRAPH}/me?$select=displayName,mail,userPrincipalName`, { headers: { authorization: `Bearer ${accessToken}` } });
  const me = (await res.json().catch(() => ({}))) as { displayName?: string; mail?: string; userPrincipalName?: string };
  const email = me.mail || me.userPrincipalName;
  return { name: me.displayName || email || 'Tài khoản Microsoft', ...(email ? { email } : {}) };
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center;color:#222"><h2>${title}</h2><p>${body}</p></body>`;

/**
 * Đăng nhập Microsoft trong trình duyệt: mở `url`, Microsoft chuyển về một cổng tạm trên máy (127.0.0.1)
 * kèm mã, app đổi mã lấy token. `done` xong khi đăng nhập xong (hoặc lỗi, hủy, quá 10 phút).
 */
export async function startMicrosoftLogin(clientId: string): Promise<{ url: string; done: Promise<MsTokens>; cancel: () => void }> {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  let settle!: { resolve: (t: MsTokens) => void; reject: (e: Error) => void };
  const done = new Promise<MsTokens>((resolve, reject) => (settle = { resolve, reject }));
  const servers: Server[] = [];
  const close = () => servers.forEach((s) => s.close());
  let redirectUri = '';

  const handler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    if (u.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    const send = (status: number, title: string, body: string) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(title, body));
    if (u.searchParams.get('state') !== state) return send(400, 'Không hợp lệ', 'Hãy thử kết nối lại từ VsScience.');
    const error = u.searchParams.get('error');
    if (error) {
      send(200, 'Chưa kết nối', 'Bạn đã hủy hoặc Microsoft từ chối. Có thể đóng trang này và thử lại trong VsScience.');
      close();
      settle.reject(new CloudAuthError(u.searchParams.get('error_description')?.split('\n')[0] || error));
      return;
    }
    const code = u.searchParams.get('code');
    if (!code) return send(400, 'Không hợp lệ', 'Thiếu mã đăng nhập.');
    try {
      const r = await tokenRequest({ client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, scope: SCOPES });
      const tokens = toTokens(r);
      send(200, 'Đã kết nối OneDrive', 'Có thể đóng trang này và quay lại VsScience.');
      settle.resolve(tokens);
    } catch (err) {
      send(500, 'Chưa kết nối được', 'Có lỗi khi hoàn tất đăng nhập. Hãy thử lại trong VsScience.');
      settle.reject(err as Error);
    } finally {
      close();
    }
  };

  // Chỉ nghe trên máy này (127.0.0.1, và ::1 vì trình duyệt có thể hiểu "localhost" là ::1).
  const v4 = createServer((req, res) => void handler(req, res));
  servers.push(v4);
  await new Promise<void>((resolve, reject) => v4.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = (v4.address() as { port: number }).port;
  const v6 = createServer((req, res) => void handler(req, res));
  v6.on('error', () => {});
  v6.listen(port, '::1');
  servers.push(v6);
  // Microsoft nhận mọi cổng với địa chỉ http://localhost đã đăng ký.
  redirectUri = `http://localhost:${port}`;

  const timer = setTimeout(() => {
    close();
    settle.reject(new CloudAuthError('Quá thời gian chờ đăng nhập'));
  }, LOGIN_TIMEOUT_MS);
  timer.unref();
  void done.finally(() => clearTimeout(timer)).catch(() => {});

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  });
  return {
    url: `${AUTH}/authorize?${params}`,
    done,
    cancel: () => {
      close();
      settle.reject(new CloudAuthError('Đã hủy'));
    },
  };
}

/** Đường dẫn trên OneDrive: mã hóa từng phần (giữ dấu "/"). */
function encodePath(p: string): string {
  return p
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

export class OneDriveDrive implements CloudDrive {
  constructor(
    private readonly token: (force?: boolean) => Promise<string>,
    /** Địa chỉ Microsoft Graph (test dùng máy chủ giả). */
    private readonly graph = GRAPH,
  ) {}

  #item(p: string): string {
    return `${this.graph}/me/drive/special/approot:/${encodePath(p)}:`;
  }

  /** Gọi Graph: tự lấy lại token khi hết hạn, chờ rồi thử lại khi bị giới hạn tốc độ. */
  async #fetch(url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const token = await this.token(attempt === 1);
    const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
    if (res.status === 401 && attempt === 0) return this.#fetch(url, init, 1);
    if (res.status === 401) throw new CloudAuthError();
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 5) {
      const wait = Math.min(60, Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.#fetch(url, init, attempt + 2);
    }
    return res;
  }

  async #fail(res: Response, what: string): Promise<never> {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(`${what}: ${body?.error?.message ?? `lỗi ${res.status}`}`);
  }

  async read(p: string) {
    // Mã phiên bản (eTag) lấy từ thông tin file; nội dung tải qua /content (Graph chuyển hướng tới chỗ tải,
    // fetch tự đi theo và không gửi kèm mã truy cập sang máy chủ khác).
    const meta = await this.#fetch(this.#item(p));
    if (meta.status === 404) return null;
    if (!meta.ok) return this.#fail(meta, `Không đọc được ${p}`);
    const { eTag } = (await meta.json()) as { eTag?: string };
    const res = await this.#fetch(`${this.#item(p)}/content`);
    if (res.status === 404) return null;
    if (!res.ok) return this.#fail(res, `Không tải được ${p}`);
    return { data: Buffer.from(await res.arrayBuffer()), etag: eTag ?? '' };
  }

  async write(p: string, data: Uint8Array, opts: { ifMatch?: string | null } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
    let url = `${this.#item(p)}/content`;
    if (opts.ifMatch === null) url += '?@microsoft.graph.conflictBehavior=fail';
    else if (opts.ifMatch) headers['if-match'] = opts.ifMatch;
    if (data.byteLength > SIMPLE_UPLOAD_MAX) {
      if (opts.ifMatch !== undefined) throw new Error('Ghi có điều kiện chỉ dùng cho file nhỏ');
      await this.#session(p, data.byteLength, async (start, end) => Buffer.from(data.subarray(start, end)));
      return { etag: '' };
    }
    const res = await this.#fetch(url, { method: 'PUT', headers, body: data as unknown as BodyInit });
    if (res.status === 412 || res.status === 409) throw new CloudConflict();
    if (!res.ok) return this.#fail(res, `Không ghi được ${p}`);
    return { etag: ((await res.json()) as { eTag: string }).eTag };
  }

  async upload(p: string, absFile: string) {
    const { size } = await stat(absFile);
    const fh = await open(absFile, 'r');
    try {
      const read = async (start: number, end: number) => {
        const buf = Buffer.alloc(end - start);
        await fh.read(buf, 0, buf.length, start);
        return buf;
      };
      if (size <= SIMPLE_UPLOAD_MAX) {
        const res = await this.#fetch(`${this.#item(p)}/content`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: (await read(0, size)) as unknown as BodyInit });
        if (!res.ok) return this.#fail(res, `Không tải lên được ${p}`);
        return;
      }
      await this.#session(p, size, read);
    } finally {
      await fh.close();
    }
  }

  /** Tải lên file lớn theo phiên (từng phần), ghi đè file cũ. */
  async #session(p: string, size: number, read: (start: number, end: number) => Promise<Buffer>) {
    const res = await this.#fetch(`${this.#item(p)}/createUploadSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    });
    if (!res.ok) return this.#fail(res, `Không tải lên được ${p}`);
    const { uploadUrl } = (await res.json()) as { uploadUrl?: string };
    if (!uploadUrl) throw new Error(`OneDrive không mở được phiên tải lên cho ${p}`);
    for (let start = 0; start < size; start += CHUNK) {
      const end = Math.min(size, start + CHUNK);
      const body = await read(start, end);
      let put: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-range': `bytes ${start}-${end - 1}/${size}` }, body: body as unknown as BodyInit }).catch(() => null);
        if (put && (put.ok || put.status < 500)) break;
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      }
      if (!put?.ok) {
        await fetch(uploadUrl, { method: 'DELETE' }).catch(() => {});
        return put ? this.#fail(put, `Không tải lên được ${p}`) : Promise.reject(new Error(`Mất kết nối khi tải lên ${p}`));
      }
    }
  }

  async download(p: string, absFile: string) {
    const res = await this.#fetch(`${this.#item(p)}/content`);
    if (res.status === 404) return false;
    if (!res.ok || !res.body) return this.#fail(res, `Không tải được ${p}`);
    await mkdir(path.dirname(absFile), { recursive: true });
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(absFile));
    return true;
  }

  async remove(p: string) {
    const res = await this.#fetch(this.#item(p), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) return this.#fail(res, `Không xóa được ${p}`);
  }

  async listFolders() {
    const res = await this.#fetch(`${this.graph}/me/drive/special/approot/children?$select=name,folder&$top=500`);
    if (!res.ok) return this.#fail(res, 'Không đọc được danh sách thư mục');
    const { value } = (await res.json()) as { value: { name: string; folder?: unknown }[] };
    return value.filter((v) => v.folder).map((v) => v.name);
  }
}
