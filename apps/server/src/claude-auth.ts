import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AuthStatus, LoginProgress } from '@ide/shared';
import { PathError } from './paths.js';
import { withRuntime } from './runtime.js';

/**
 * Đường dẫn Claude Code CLI đi kèm Claude Agent SDK (gói nhị phân theo hệ điều hành).
 * Ghi đè bằng IDE_CLAUDE_BIN nếu muốn dùng bản cài riêng.
 */
export function resolveClaudeBin(): string {
  if (process.env.IDE_CLAUDE_BIN) return process.env.IDE_CLAUDE_BIN;
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  try {
    const require = createRequire(import.meta.url);
    const sdkRequire = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'));
    const dir = path.dirname(sdkRequire.resolve(`${pkg}/package.json`));
    return path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  } catch {
    return 'claude'; // không có gói nhị phân: thử bản cài trong PATH
  }
}

/**
 * Môi trường chạy CLI: bỏ API key để luôn dùng phiên đăng nhập Claude.ai
 * (Claude Code ưu tiên ANTHROPIC_API_KEY hơn gói thuê bao nếu biến này có mặt).
 */
export function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = withRuntime({ ...process.env, ...extra });
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/** Bỏ mã điều khiển terminal (màu, link OSC 8) để đọc được thông báo của CLI. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const URL_WAIT_MS = 15_000;

/**
 * Đăng nhập Claude.ai như plugin VS Code: chạy `claude auth login`, bắt link mà CLI
 * định mở trình duyệt (qua biến BROWSER) rồi để giao diện mở link đó. Sau khi người dùng
 * cấp quyền, trình duyệt gọi về localhost của CLI và CLI tự lưu thông tin đăng nhập
 * vào ~/.claude — dùng chung với Claude Code và Agent SDK trên máy này.
 */
export class ClaudeAuth {
  #child: ChildProcess | null = null;
  #progress: LoginProgress = { state: 'idle', autoUrl: null, manualUrl: null, message: null };
  #tmp: string | null = null;

  constructor(private readonly bin: string) {}

  status(): Promise<AuthStatus> {
    return new Promise((resolve) => {
      execFile(this.bin, ['auth', 'status'], { env: cliEnv(), timeout: 15_000 }, (err, stdout) => {
        try {
          const d = JSON.parse(stdout) as Record<string, unknown>;
          const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
          resolve({
            loggedIn: d.loggedIn === true,
            method: str(d.authMethod) ?? 'none',
            email: str(d.email),
            plan: str(d.subscriptionType),
            orgName: str(d.orgName),
          });
        } catch {
          const missing = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
          resolve({
            loggedIn: false,
            method: 'none',
            email: null,
            plan: null,
            orgName: null,
            error: missing ? 'Không tìm thấy Claude Code trên máy.' : 'Không đọc được trạng thái đăng nhập Claude.',
          });
        }
      });
    });
  }

  progress(): LoginProgress {
    return this.#progress;
  }

  /** Bắt đầu đăng nhập; trả về khi đã có link để mở. */
  async startLogin(): Promise<LoginProgress> {
    this.cancel();
    const tmp = mkdtempSync(path.join(tmpdir(), 'ide-login-'));
    this.#tmp = tmp;
    const urlFile = path.join(tmp, 'url');
    // CLI gọi $BROWSER <url>: ghi link ra file thay vì mở trình duyệt trên máy chủ (để giao diện
    // hiện link — cần khi chạy trong WSL). Windows không chạy được script sh: để CLI tự mở trình duyệt
    // mặc định, giao diện vẫn có link dự phòng.
    let browserEnv: Record<string, string> = {};
    if (process.platform !== 'win32') {
      const opener = path.join(tmp, 'open-browser.sh');
      writeFileSync(opener, `#!/bin/sh\nprintf '%s' "$1" > '${urlFile}'\n`, { mode: 0o700 });
      browserEnv = { BROWSER: opener };
    }

    this.#progress = { state: 'waiting', autoUrl: null, manualUrl: null, message: null };
    const child = spawn(this.bin, ['auth', 'login', '--claudeai'], {
      env: cliEnv(browserEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    const timer = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS);

    let output = '';
    const onData = (buf: Buffer) => {
      const raw = buf.toString();
      output += raw;
      const manual = /https:\/\/[^\s\x07\x1b]*oauth\/authorize[^\s\x07\x1b]*/.exec(raw);
      if (manual && !this.#progress.manualUrl) this.#progress = { ...this.#progress, manualUrl: manual[0] };
      if (/invalid code/i.test(stripAnsi(raw))) {
        this.#progress = { ...this.#progress, message: 'Mã không đúng. Hãy sao chép lại toàn bộ mã rồi thử lại.' };
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      this.#progress = { ...this.#progress, state: 'error', message: `Không chạy được Claude Code: ${err.message}` };
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (this.#child !== child) return; // đã bị hủy hoặc thay bằng lần đăng nhập mới
      this.#child = null;
      this.#cleanup();
      if (code === 0) {
        this.#progress = { ...this.#progress, state: 'success', message: null };
      } else if (this.#progress.state === 'waiting') {
        const last = stripAnsi(output).trim().split('\n').filter(Boolean).pop();
        this.#progress = { ...this.#progress, state: 'error', message: last ?? 'Đăng nhập không thành công.' };
      }
    });

    // Đợi link: link tự động (qua BROWSER) hoặc ít nhất link dự phòng trong output.
    const deadline = Date.now() + URL_WAIT_MS;
    while (Date.now() < deadline && this.#child === child) {
      if (existsSync(urlFile)) {
        const url = readFileSync(urlFile, 'utf8').trim();
        if (url) this.#progress = { ...this.#progress, autoUrl: url };
      }
      if (this.#progress.autoUrl && this.#progress.manualUrl) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.#progress.autoUrl && !this.#progress.manualUrl && this.#progress.state === 'waiting') {
      this.cancel();
      this.#progress = { ...this.#progress, state: 'error', message: 'Claude Code không trả về link đăng nhập.' };
    }
    return this.#progress;
  }

  /** Dán mã từ trang web (khi trình duyệt không tự gọi về được, thường gặp trên WSL2). */
  submitCode(code: string) {
    const child = this.#child;
    if (!child?.stdin?.writable) throw new PathError('Không có phiên đăng nhập nào đang chờ mã', 409);
    this.#progress = { ...this.#progress, message: null };
    child.stdin.write(code.trim() + '\n');
  }

  cancel() {
    const child = this.#child;
    this.#child = null;
    child?.kill();
    this.#cleanup();
    if (this.#progress.state === 'waiting') this.#progress = { ...this.#progress, state: 'idle' };
  }

  /** Đăng xuất Claude Code trên máy (dùng chung với plugin VS Code). */
  logout(): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, ['auth', 'logout'], { env: cliEnv(), timeout: 30_000 }, (err) =>
        err ? reject(new PathError('Không đăng xuất được', 500)) : resolve(),
      );
    });
  }

  #cleanup() {
    if (this.#tmp) rmSync(this.#tmp, { recursive: true, force: true });
    this.#tmp = null;
  }
}
