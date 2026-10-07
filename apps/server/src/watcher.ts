import path from 'node:path';
import { watch } from 'chokidar';
import type { FsEventType } from '@ide/shared';
import { fileKind, isHiddenName, toRelPosix } from './paths.js';

export type Change = { event: FsEventType; path: string };

const FS_EVENTS = new Set<string>(['add', 'addDir', 'change', 'unlink', 'unlinkDir']);
const isFsEvent = (e: string): e is FsEventType => FS_EVENTS.has(e);

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
    usePolling: opts.usePolling,
    interval: 1000,
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
