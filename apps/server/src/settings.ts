import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Cài đặt chung của app (mọi cửa sổ dùng chung, lưu cạnh state.json). */
export interface AppSettings {
  /** Tự lưu bản (mục Thay đổi) khi Claude xong một việc đủ lớn. Mặc định bật. */
  autoSave: boolean;
  /** Thông báo khi Claude xong việc / hỏi lại / cần cho phép — bản trình duyệt (app desktop lưu riêng). */
  notifications: boolean;
}

const DEFAULTS: AppSettings = { autoSave: true, notifications: true };

export function readSettings(file: string): AppSettings {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppSettings>;
    const bool = (k: keyof AppSettings) => (typeof raw[k] === 'boolean' ? raw[k] : DEFAULTS[k]);
    return { autoSave: bool('autoSave'), notifications: bool('notifications') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(file: string, patch: Partial<AppSettings>): AppSettings {
  const next = { ...readSettings(file), ...patch };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}
