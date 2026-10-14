import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FolderSettings } from '@ide/shared';
import { folderDataPath } from './folderData.js';

/** Cài đặt của máy (lưu cạnh state.json): chỉ những gì gắn với máy, ví dụ thông báo của bản trình duyệt. */
export interface DeviceSettings {
  notifications: boolean;
}

const DEVICE_DEFAULTS: DeviceSettings = { notifications: true };

function readJson(file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeJson(file: string, value: object) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function readDeviceSettings(file: string): DeviceSettings {
  const raw = readJson(file);
  return { notifications: typeof raw.notifications === 'boolean' ? raw.notifications : DEVICE_DEFAULTS.notifications };
}

export function writeDeviceSettings(file: string, patch: Partial<DeviceSettings>): DeviceSettings {
  const next = { ...readDeviceSettings(file), ...patch };
  writeJson(file, { ...readJson(file), ...next });
  return next;
}

/** Cài đặt của thư mục làm việc (.vsscience/settings.json): đi theo thư mục sang máy khác. */
const folderFile = (root: string) => folderDataPath(root, 'settings.json');

export function readFolderSettings(root: string): FolderSettings {
  const raw = readJson(folderFile(root));
  const chat = raw.chat as FolderSettings['chat'] | undefined;
  return {
    autoSave: typeof raw.autoSave === 'boolean' ? raw.autoSave : true,
    ...(chat && typeof chat === 'object' && typeof chat.model === 'string' ? { chat } : {}),
  };
}

export function writeFolderSettings(root: string, patch: Partial<FolderSettings>): FolderSettings {
  const next = { ...readFolderSettings(root), ...patch };
  writeJson(folderFile(root), next);
  return next;
}
