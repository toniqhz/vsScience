import { describe, expect, it } from 'vitest';
import { fsTypeOf, needsPolling } from '../src/watcher.js';

const MOUNTS = [
  '/dev/sdd / ext4 rw,relatime 0 0',
  'C:\\134 /mnt/c 9p rw,noatime,aname=drvfs;path=C:\\ 0 0',
  '//nas/tai\\040lieu /mnt/nas cifs rw 0 0',
  'tmpfs /mnt/cache tmpfs rw 0 0',
].join('\n');

describe('nhận dạng ổ cần polling', () => {
  it('ổ Windows trong WSL và ổ mạng cần polling, ổ Linux thì không', () => {
    expect(needsPolling('/mnt/c/Users/Tuan Nguyen/OneDrive/Desktop/cham thi', MOUNTS)).toBe(true);
    expect(needsPolling('/mnt/nas/de thi', MOUNTS)).toBe(true);
    expect(needsPolling('/home/toniqhz/tai-lieu', MOUNTS)).toBe(false);
  });

  it('chọn điểm gắn dài nhất và không nhầm tiền tố tên thư mục', () => {
    expect(fsTypeOf('/mnt/cache/x', MOUNTS)).toBe('tmpfs');
    expect(fsTypeOf('/mnt/cx', MOUNTS)).toBe('ext4');
    expect(fsTypeOf('/mnt/c', MOUNTS)).toBe('9p');
  });
});
