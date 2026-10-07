/**
 * Tiến trình chính của app desktop: chạy server (Fastify + Claude Agent SDK) ngay trong
 * tiến trình này, rồi mở cửa sổ trỏ tới giao diện web do server phục vụ ở 127.0.0.1.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { BrowserWindow, Menu, app, dialog, shell } from 'electron';

const isPackaged = app.isPackaged;
/** Tài nguyên đi kèm: trong bản đóng gói là thư mục resources; khi chạy thử từ repo là build/. */
const resources = isPackaged ? process.resourcesPath : path.resolve(import.meta.dirname, '../build/resources');
const smokeArg = process.argv.find((a) => a.startsWith('--smoke-test='));

function configureEnv() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  process.env.IDE_CONFIG_DIR ??= app.getPath('userData');
  process.env.IDE_WEB_DIST ??= path.join(resources, 'web');
  process.env.IDE_CLAUDE_BIN ??= path.join(resources, 'claude', exe);
  process.env.IDE_CLAUDE_PROFILE ??= path.join(resources, 'profile');
  // Python portable có sẵn thư viện xử lý Word/Excel/PDF (không có khi chạy thử từ repo chưa build).
  const python = path.join(resources, 'python');
  if (existsSync(python)) process.env.IDE_PYTHON_HOME ??= python;
  process.env.IDE_DEFAULT_WORKSPACE ??= app.getPath('documents');
  // Cổng ngẫu nhiên: nhiều người dùng / nhiều bản chạy cùng lúc không đụng nhau.
  process.env.IDE_PORT ??= '0';
}

async function startServer() {
  configureEnv();
  // Nạp sau khi đặt biến môi trường vì config đọc chúng lúc khởi tạo.
  const { loadConfig } = await import('../../server/src/config.js');
  const { buildApp } = await import('../../server/src/app.js');
  const config = loadConfig();
  const { app: server, workspace } = await buildApp(config);
  await server.listen({ host: config.host, port: config.port });
  const { port } = server.server.address() as AddressInfo;
  return { server, workspace, config, url: `http://127.0.0.1:${port}/?token=${encodeURIComponent(config.token)}`, port };
}

/** Kiểm tra bản đóng gói mà không mở cửa sổ: server chạy, giao diện có, Claude CLI chạy được. */
async function smokeTest(outFile: string) {
  const result: Record<string, unknown> = { platform: process.platform, arch: process.arch, resources };
  try {
    const { server, url, port, config } = await startServer();
    result.workspace = config.initialWorkspace;
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
    const page = await fetch(url).then((r) => r.text());
    result.health = health;
    result.webOk = page.includes('<div id="root">');
    result.claudeBin = config.claudeBin;
    result.claudeExists = existsSync(config.claudeBin);
    const { stdout } = await promisify(execFile)(config.claudeBin, ['--version'], { timeout: 60_000 });
    result.claudeVersion = stdout.trim();
    const profile = await fetch(`http://127.0.0.1:${port}/api/agent/profile`, {
      headers: { authorization: `Bearer ${config.token}` },
    }).then((r) => r.json());
    result.profile = profile;
    // Python đi kèm, chạy bằng đúng môi trường mà Claude dùng (PATH, UTF-8…).
    if (process.env.IDE_PYTHON_HOME) {
      const { withRuntime } = await import('../../server/src/runtime.js');
      const env = withRuntime({ ...process.env });
      const check = [
        'import sys, os, tempfile, docx, openpyxl, xlrd, fitz, pandas, numpy, scipy, matplotlib',
        "p = os.path.join(tempfile.gettempdir(), 'kiem-tra-de.docx')",
        "d = docx.Document(); d.add_paragraph('Đề kiểm tra — Câu 1'); d.save(p)",
        "print(docx.Document(p).paragraphs[0].text, '|', sys.version.split()[0], '|', sys.executable)",
        'os.remove(p)',
      ].join('\n');
      const script = path.join(tmpdir(), `banlamviec-check-${process.pid}.py`);
      writeFileSync(script, check);
      // Gọi "python" qua shell như Claude: kiểm tra PATH trỏ đúng Python đi kèm.
      const [shellExe, shellArgs] =
        process.platform === 'win32'
          ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `python '${script}'`]]
          : ['/bin/sh', ['-c', `python '${script}'`]];
      const { stdout } = await promisify(execFile)(shellExe, shellArgs, { env, timeout: 120_000 });
      result.python = stdout.trim();
    }
    await server.close();
    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.error = String((err as Error)?.stack ?? err);
  }
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
}

async function createWindow() {
  const { url, server } = await startServer();
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1f1f1f',
    title: 'Bàn làm việc',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  // Link ra ngoài (đăng nhập claude.ai, link trong câu trả lời) mở bằng trình duyệt mặc định.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith('http://127.0.0.1:')) {
      event.preventDefault();
      if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    }
  });

  await win.loadURL(url);
  app.on('before-quit', () => void server.close());
}

if (smokeArg) {
  // Kiểm tra không đụng tới dữ liệu thật: dữ liệu app và thư mục làm việc đều ở thư mục tạm.
  const tmp = mkdtempSync(path.join(tmpdir(), 'banlamviec-smoke-'));
  app.setPath('userData', path.join(tmp, 'userData'));
  process.env.IDE_CONFIG_DIR = path.join(tmp, 'config');
  process.env.IDE_WORKSPACE = mkdtempSync(path.join(tmp, 'ws-'));
  app.whenReady().then(() => smokeTest(smokeArg.slice('--smoke-test='.length)));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    try {
      await createWindow();
    } catch (err) {
      dialog.showErrorBox('Không khởi động được Bàn làm việc', String((err as Error)?.message ?? err));
      app.quit();
    }
  });
  app.on('window-all-closed', () => app.quit());
}
