/**
 * Thông báo của hệ điều hành khi Claude xong việc, hỏi lại hoặc cần cho phép.
 * Chỉ báo khi cửa sổ đó không được xem (đang ở app khác hoặc thu nhỏ); bấm vào thông báo thì mở lại cửa sổ.
 * Bật/tắt lưu trong thư mục dữ liệu của app, dùng chung cho mọi cửa sổ.
 *
 * macOS: thông báo của Electron cần app được ký bằng Apple Developer ID; bản chưa ký (ký ad-hoc) có thể bị
 * macOS từ chối và Electron chỉ báo sự kiện `failed`. Khi đó app dùng thông báo dự phòng qua AppleScript
 * (`osascript`, có sẵn trên mọi máy Mac — hiện dưới tên "Script Editor"), và luôn đặt chấm đỏ trên biểu tượng
 * Dock cho tới khi người dùng quay lại app.
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, Notification, app } from 'electron';
import type { AppNotification } from '../../server/src/notify.js';

const settingsFile = () => path.join(app.getPath('userData'), 'notifications.json');
const isMac = process.platform === 'darwin';

let enabled: boolean | undefined;
/** Giữ tham chiếu tới thông báo đang hiện: bị dọn rác thì bấm vào không còn tác dụng (Windows). */
const shown = new Set<Notification>();
/** Lỗi lần gần nhất thông báo của hệ điều hành không hiện được (để menu Cài đặt báo lại). */
let lastError: string | undefined;
/** macOS đã từ chối thông báo của Electron: từ đó dùng thẳng thông báo dự phòng. */
let useFallback = false;

function isEnabled(): boolean {
  if (enabled === undefined) {
    try {
      enabled = (JSON.parse(readFileSync(settingsFile(), 'utf8')) as { enabled?: unknown }).enabled !== false;
    } catch {
      enabled = true; // mặc định bật
    }
  }
  return enabled;
}

/** Chuỗi trong AppleScript: thoát dấu \ và ". */
function appleString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Thông báo dự phòng trên Mac qua AppleScript (không cần app được ký). */
function showFallback(n: Pick<AppNotification, 'title' | 'body'>) {
  const script = `display notification ${appleString(n.body.slice(0, 240))} with title ${appleString('VsScience')} subtitle ${appleString(n.title)}`;
  execFile('osascript', ['-e', script], { timeout: 10_000 }, (err) => {
    if (err) lastError = `Không hiện được thông báo: ${err.message}`;
  });
}

function show(win: BrowserWindow | undefined, n: Pick<AppNotification, 'title' | 'body'>) {
  if (isMac && (useFallback || !Notification.isSupported())) return showFallback(n);
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: n.title, body: n.body });
  shown.add(note);
  const forget = () => shown.delete(note);
  note.on('click', () => {
    forget();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  note.on('close', forget);
  note.on('failed', (_e, error) => {
    forget();
    lastError = error || 'Hệ điều hành không cho app hiện thông báo';
    // macOS từ chối (thường do app chưa ký bằng Apple Developer ID): chuyển sang thông báo dự phòng.
    if (isMac) {
      useFallback = true;
      showFallback(n);
    }
  });
  note.show();
}

/** Chấm đỏ trên biểu tượng Dock (Mac) tới khi người dùng quay lại app. */
let dockMarked = false;
function markDock() {
  if (!isMac || !app.dock || dockMarked) return;
  dockMarked = true;
  app.dock.setBadge('•');
  app.once('browser-window-focus', () => {
    dockMarked = false;
    app.dock?.setBadge('');
  });
}

/** Bộ thông báo cho một cửa sổ (truyền vào server của cửa sổ đó). */
export function notifierFor(getWin: () => BrowserWindow | undefined) {
  return {
    enabled: isEnabled,
    setEnabled(on: boolean) {
      enabled = on;
      try {
        writeFileSync(settingsFile(), JSON.stringify({ enabled: on }) + '\n');
      } catch {
        // không ghi được: vẫn dùng trong lần chạy này
      }
      // Bật lên: hiện một thông báo mẫu để thấy ngay (và để macOS hỏi quyền lần đầu).
      if (on) show(getWin(), { title: 'Đã bật thông báo', body: 'VsScience sẽ báo khi Claude xong việc, hỏi lại hoặc cần bạn cho phép.' });
    },
    /** Tình trạng thông báo trên máy này: lỗi gần nhất, có đang dùng thông báo dự phòng không. */
    status() {
      return { ...(lastError ? { error: lastError } : {}), fallback: useFallback };
    },
    notify(n: AppNotification) {
      const win = getWin();
      if (!win || win.isDestroyed()) return;
      // Đang nhìn cửa sổ này thì không cần báo.
      if (win.isFocused() && win.isVisible() && !win.isMinimized()) return;
      show(win, n);
      markDock();
      // Nháy biểu tượng trên taskbar (Windows) / nảy biểu tượng trên Dock (Mac) khi cần người dùng trả lời.
      if (n.kind === 'permission' || n.kind === 'question') {
        if (isMac) app.dock?.bounce('informational');
        else win.flashFrame(true);
      }
    },
  };
}
