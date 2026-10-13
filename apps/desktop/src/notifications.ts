/**
 * Thông báo của hệ điều hành khi Claude xong việc, hỏi lại hoặc cần cho phép.
 * Chỉ báo khi cửa sổ đó không được xem (đang ở app khác hoặc thu nhỏ); bấm vào thông báo thì mở lại cửa sổ.
 * Bật/tắt lưu trong thư mục dữ liệu của app, dùng chung cho mọi cửa sổ.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, Notification, app } from 'electron';
import type { AppNotification } from '../../server/src/notify.js';

const settingsFile = () => path.join(app.getPath('userData'), 'notifications.json');

let enabled: boolean | undefined;
/** Giữ tham chiếu tới thông báo đang hiện: bị dọn rác thì bấm vào không còn tác dụng (Windows). */
const shown = new Set<Notification>();

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

function show(win: BrowserWindow | undefined, n: Pick<AppNotification, 'title' | 'body'>) {
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
  note.on('failed', forget);
  note.show();
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
    notify(n: AppNotification) {
      const win = getWin();
      if (!win || win.isDestroyed()) return;
      // Đang nhìn cửa sổ này thì không cần báo.
      if (win.isFocused() && win.isVisible() && !win.isMinimized()) return;
      show(win, n);
      // Nháy biểu tượng trên taskbar (Windows) / nảy biểu tượng trên Dock (Mac) khi cần người dùng trả lời.
      if (n.kind === 'permission' || n.kind === 'question') {
        if (process.platform === 'darwin') app.dock?.bounce('informational');
        else win.flashFrame(true);
      }
    },
  };
}
