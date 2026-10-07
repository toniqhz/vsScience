import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Trạng thái lưu giữa các lần chạy (~/.config/ide/state.json). */
export interface AppState {
  lastWorkspace?: string;
  recent: string[];
}

const MAX_RECENT = 8;

export function readState(file: string): AppState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppState>;
    return {
      lastWorkspace: typeof raw.lastWorkspace === 'string' ? raw.lastWorkspace : undefined,
      recent: Array.isArray(raw.recent) ? raw.recent.filter((r) => typeof r === 'string') : [],
    };
  } catch {
    return { recent: [] };
  }
}

export function rememberWorkspace(file: string, dir: string): AppState {
  const state = readState(file);
  state.lastWorkspace = dir;
  state.recent = [dir, ...state.recent.filter((r) => r !== dir)].slice(0, MAX_RECENT);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  return state;
}
