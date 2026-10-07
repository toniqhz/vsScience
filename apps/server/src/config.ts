import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaudeBin } from './claude-auth.js';
import { readState } from './state.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface Config {
  host: string;
  port: number;
  /** Thư mục làm việc lúc khởi động (người dùng đổi được trong app). */
  initialWorkspace: string;
  token: string;
  /** File lưu thư mục mở gần đây. */
  statePath: string;
  /** Claude Code CLI dùng để đăng nhập Claude.ai và chạy agent. */
  claudeBin: string;
  /** Nơi chứa kho git của bản lưu (ngoài thư mục làm việc). */
  snapshotsDir: string;
  /** Thư mục nháp cho script tạm của Claude (mỗi thư mục làm việc một thư mục con). */
  scratchDir: string;
  /** Địa chỉ người dùng mở trong trình duyệt (dev: cổng Vite). */
  openUrl: string;
  /** Thư mục bản build của web; phục vụ tĩnh nếu tồn tại. */
  webDist: string;
  /** Thư mục hồ sơ Claude dựng sẵn (CLAUDE.md, subagent, output style); null nếu không dùng. */
  profileDir: string | null;
  /** Bật polling cho chokidar (cần khi thư mục nằm trên /mnt/c trong WSL hoặc ổ mạng). */
  usePolling: boolean;
}

/** Nơi lưu token, thư mục gần đây, kho bản lưu. App desktop đặt IDE_CONFIG_DIR vào thư mục dữ liệu của app. */
const configDir = process.env.IDE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'ide');

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Ưu tiên: IDE_WORKSPACE → thư mục mở lần trước → IDE_DEFAULT_WORKSPACE (app desktop) → demo-workspace trong repo. */
function resolveWorkspace(statePath: string): string {
  if (process.env.IDE_WORKSPACE) return path.resolve(process.env.IDE_WORKSPACE);
  const last = readState(statePath).lastWorkspace;
  if (last && isDir(last)) return last;
  const fallback = process.env.IDE_DEFAULT_WORKSPACE;
  if (fallback && isDir(fallback)) return path.resolve(fallback);
  const demo = path.join(repoRoot, 'demo-workspace');
  mkdirSync(demo, { recursive: true });
  return demo;
}

/** Hồ sơ Claude: IDE_CLAUDE_PROFILE (rỗng để tắt) → claude-code-khoa-hoc/ trong repo. */
function resolveProfileDir(): string | null {
  const env = process.env.IDE_CLAUDE_PROFILE;
  if (env !== undefined) return env.trim() ? path.resolve(env) : null;
  const bundled = path.join(repoRoot, 'claude-code-khoa-hoc/claude-code-khoa-hoc');
  return isDir(bundled) ? bundled : null;
}

/**
 * Token cố định theo máy, lưu ở ~/.config/ide/token (quyền 600),
 * để server khởi động lại (tsx watch) không làm hỏng phiên trình duyệt đang mở.
 */
function resolveToken(): string {
  if (process.env.IDE_TOKEN) return process.env.IDE_TOKEN;
  const file = path.join(configDir, 'token');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // chưa có token — tạo mới bên dưới
  }
  const token = randomBytes(24).toString('base64url');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(file, token + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

export function loadConfig(): Config {
  const port = Number(process.env.IDE_PORT ?? 4317);
  const host = '127.0.0.1';
  const statePath = path.join(configDir, 'state.json');
  return {
    host,
    port,
    initialWorkspace: resolveWorkspace(statePath),
    token: resolveToken(),
    statePath,
    claudeBin: resolveClaudeBin(),
    snapshotsDir: path.join(configDir, 'snapshots'),
    scratchDir: path.join(configDir, 'scratch'),
    // `pnpm dev` chạy kèm Vite ở cổng 5173; giao diện được phục vụ từ đó.
    openUrl:
      process.env.IDE_OPEN_URL ??
      (process.env.npm_lifecycle_event === 'dev' ? `http://${host}:5173` : `http://${host}:${port}`),
    webDist: process.env.IDE_WEB_DIST || path.join(repoRoot, 'apps/web/dist'),
    profileDir: resolveProfileDir(),
    usePolling: process.env.IDE_POLLING === '1',
  };
}
