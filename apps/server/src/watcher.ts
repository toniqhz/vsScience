import { readFileSync } from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';
import type { FsEventType } from '@ide/shared';
import { fileKind, isHiddenName, toRelPosix } from './paths.js';

export type Change = { event: FsEventType; path: string };

const FS_EVENTS = new Set<string>(['add', 'addDir', 'change', 'unlink', 'unlinkDir']);
const isFsEvent = (e: string): e is FsEventType => FS_EVENTS.has(e);

/** Loại ổ không phát sự kiện inotify: ổ Windows trong WSL (9p/drvfs) và ổ mạng. */
const NO_INOTIFY_FS = new Set(['9p', 'drvfs', 'v9fs', 'cifs', 'smb3', 'smbfs', 'nfs', 'nfs4', 'fuse.sshfs', 'fuse.rclone']);

/** Đọc /proc/mounts, trả về loại ổ chứa `dir` (điểm gắn dài nhất khớp với đường dẫn). */
export function fsTypeOf(dir: string, mounts?: string): string | null {
  let text = mounts;
  if (text === undefined) {
    try {
      text = readFileSync('/proc/mounts', 'utf8');
    } catch {
      return null; // không phải Linux
    }
  }
  let best: { point: string; type: string } | null = null;
  for (const line of text.split('\n')) {
    const [, rawPoint, type] = line.split(' ');
    if (!rawPoint || !type) continue;
    // /proc/mounts mã hóa dấu cách và ký tự đặc biệt dạng \040.
    const point = rawPoint.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    const inside = point === '/' || dir === point || dir.startsWith(point.endsWith('/') ? point : point + '/');
    if (inside && (!best || point.length > best.point.length)) best = { point, type };
  }
  return best?.type ?? null;
}

/** Thư mục trên ổ Windows (WSL) hay ổ mạng cần polling vì không nhận được sự kiện thay đổi file. */
export function needsPolling(dir: string, mounts?: string): boolean {
  const type = fsTypeOf(dir, mounts);
  return type !== null && NO_INOTIFY_FS.has(type);
}

/**
 * Theo dõi thư mục làm việc và gọi `onChanges` theo lô (gom trong `batchMs`)
 * để giao diện không phải tải lại cây sau từng sự kiện nhỏ lẻ.
 */
export function watchWorkspace(
  root: string,
  onChanges: (changes: Change[]) => void,
  opts: { usePolling: boolean; batchMs?: number },
) {
  const batchMs = opts.batchMs ?? 150;
  let pending: Change[] = [];
  let timer: NodeJS.Timeout | undefined;

  const watcher = watch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    usePolling: opts.usePolling || needsPolling(root),
    interval: 1000,
    binaryInterval: 1000,
    // Word/Excel lưu file qua nhiều bước ghi; đợi file ổn định rồi mới báo.
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored: (p) => p !== root && isHiddenName(path.basename(p)),
  });

  watcher.on('all', (event, absPath) => {
    if (!isFsEvent(event)) return;
    const isDirEvent = event === 'addDir' || event === 'unlinkDir';
    if (!isDirEvent && !fileKind(absPath)) return;
    const rel = toRelPosix(root, absPath);
    if (rel === '') return;
    pending.push({ event, path: rel });
    timer ??= setTimeout(() => {
      const batch = pending;
      pending = [];
      timer = undefined;
      onChanges(batch);
    }, batchMs);
  });

  watcher.on('error', (err) => {
    console.error('[watcher]', err);
  });

  return {
    close: async () => {
      clearTimeout(timer);
      await watcher.close();
    },
  };
}
