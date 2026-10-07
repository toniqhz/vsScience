import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PackInfo } from '@ide/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { PackManager } from '../src/packs.js';
import { installedPackDirs, runtimePrompt, withRuntime } from '../src/runtime.js';

let base: string;
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Python giả: in ra giống pip rồi ghi một file vào --target; MODE=hash thì báo sai mã kiểm tra. */
function setup(mode: 'ok' | 'hash') {
  base = mkdtempSync(path.join(tmpdir(), 'goi-'));
  const home = path.join(base, 'python');
  mkdirSync(path.join(home, 'bin'), { recursive: true });
  mkdirSync(path.join(home, 'packs'));
  writeFileSync(
    path.join(home, 'bin', 'python3'),
    `#!/bin/sh
target=""; while [ $# -gt 0 ]; do [ "$1" = "--target" ] && target="$2"; shift; done
echo "Collecting numpy==2.3.4"; echo "Collecting scipy==1.16.3"
${mode === 'hash' ? 'echo "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE." >&2; exit 1' : 'echo "Installing collected packages: numpy, scipy"; mkdir -p "$target/numpy"; echo x > "$target/numpy/__init__.py"'}
`,
  );
  chmodSync(path.join(home, 'bin', 'python3'), 0o755);
  writeFileSync(path.join(home, 'packs', 'data.lock'), 'numpy==2.3.4 --hash=sha256:aa\nscipy==1.16.3 --hash=sha256:bb\n');
  writeFileSync(
    path.join(home, 'packs', 'data.json'),
    JSON.stringify({ id: 'data', title: 'Gói phân tích số liệu', packages: ['numpy', 'scipy'], downloadBytes: 80e6, installedBytes: 210e6 }),
  );
  const events: PackInfo[] = [];
  const packs = path.join(base, 'packs');
  return { home, packs, events, m: new PackManager(home, packs, (p) => events.push(p), 'linux') };
}

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe('gói tùy chọn', () => {
  it('chưa cài → cài, báo tiến độ, đánh dấu đã cài; Claude thấy thư viện qua PYTHONPATH', async () => {
    const { home, packs, events, m } = setup('ok');
    expect(m.list()).toMatchObject([{ id: 'data', state: 'missing', downloadBytes: 80e6 }]);
    expect(m.install('data').state).toBe('installing');
    await until(() => events.at(-1)?.state === 'installed');
    expect(events.map((e) => e.message).filter(Boolean)).toEqual(
      expect.arrayContaining(['Đang tải numpy (1/2)', 'Đang tải scipy (2/2)', 'Đang cài đặt…']),
    );
    expect(m.list()[0]!.state).toBe('installed');
    expect(installedPackDirs(packs)).toEqual([path.join(packs, 'data')]);
    expect(withRuntime({ PATH: '/usr/bin' }, home, 'linux', installedPackDirs(packs)).PYTHONPATH).toBe(path.join(packs, 'data'));
    expect(readdirSync(packs)).toEqual(['data']); // không còn thư mục tạm
  });

  it('sai mã kiểm tra: báo lỗi rõ ràng, không để lại gói cài dở, cho thử lại', async () => {
    const { packs, events, m } = setup('hash');
    m.install('data');
    await until(() => events.at(-1)?.state === 'error');
    expect(events.at(-1)?.message).toMatch(/không khớp mã kiểm tra/);
    expect(existsSync(path.join(packs, 'data'))).toBe(false);
    expect(readdirSync(packs)).toEqual([]);
    expect(m.list()[0]!.state).toBe('error');
  });

  it('nâng cấp app đổi file khóa: gói cũ coi như chưa cài để cài lại đúng phiên bản', async () => {
    const { home, events, m } = setup('ok');
    m.install('data');
    await until(() => events.at(-1)?.state === 'installed');
    writeFileSync(path.join(home, 'packs', 'data.lock'), 'numpy==2.4.0 --hash=sha256:cc\n');
    expect(m.list()[0]!.state).toBe('missing');
  });

  it('chạy dev (không có Python đi kèm): không có gói nào', () => {
    base = mkdtempSync(path.join(tmpdir(), 'goi-'));
    expect(new PackManager(null, null, () => {}).list()).toEqual([]);
  });

  it('hướng dẫn cho Claude tùy theo gói đã cài', () => {
    expect(runtimePrompt('/py', 'linux', [])).toMatch(/Chưa cài "Gói phân tích số liệu".*\/cai-goi/);
    expect(runtimePrompt('/py', 'linux', ['data'])).toMatch(/pandas, numpy, scipy, matplotlib/);
    expect(runtimePrompt(null)).toBeNull();
  });
});
