// Chuẩn bị Python portable (python-build-standalone) kèm thư viện cho từng nền tảng đích.
//   node scripts/fetch-python.mjs win-x64 mac-arm64 mac-x64
// Kết quả: build/python/<os>-<arch>/ (đưa vào app dưới resources/python).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Bản phát hành cố định để build lặp lại được. Đổi cả hai giá trị khi nâng cấp. */
const RELEASE = '20261003';
const PY = '3.12.15';
const PY_MINOR = '3.12';
const BASE = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}`;

const TARGETS = {
  'win-x64': { triple: 'x86_64-pc-windows-msvc', platforms: ['win_amd64'] },
  // Tag macOS tối đa 12.0: Electron 44 cũng cần macOS 12 trở lên, và scipy chỉ có wheel từ 12.0 (arm64).
  'mac-arm64': { triple: 'aarch64-apple-darwin', platforms: ['macosx_12_0_arm64', 'macosx_11_0_arm64', 'macosx_10_9_universal2'] },
  'mac-x64': {
    triple: 'x86_64-apple-darwin',
    platforms: [
      'macosx_12_0_x86_64', 'macosx_11_0_x86_64', 'macosx_10_15_x86_64', 'macosx_10_14_x86_64',
      'macosx_10_13_x86_64', 'macosx_10_9_x86_64', 'macosx_10_9_universal2',
    ],
  },
};
const HOST = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
}[`${process.platform}-${process.arch}`];

const desktop = path.resolve(import.meta.dirname, '..');
const cache = path.join(desktop, 'build/cache');
const outRoot = path.join(desktop, 'build/python');
mkdirSync(cache, { recursive: true });

let sums;
async function checksum(name) {
  if (!sums) {
    const res = await fetch(`${BASE}/SHA256SUMS`);
    if (!res.ok) throw new Error(`Không tải được SHA256SUMS: ${res.status}`);
    sums = new Map(
      (await res.text())
        .trim()
        .split('\n')
        .map((l) => l.trim().split(/\s+/).reverse()),
    );
  }
  const sum = sums.get(name);
  if (!sum) throw new Error(`SHA256SUMS không có ${name}`);
  return sum;
}

/** Tải (có cache) và kiểm tra SHA256 một bản Python. */
async function download(triple) {
  const name = `cpython-${PY}+${RELEASE}-${triple}-install_only_stripped.tar.gz`;
  const file = path.join(cache, name);
  const want = await checksum(name);
  if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== want) {
    console.log(`  tải ${name}`);
    const res = await fetch(`${BASE}/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Không tải được ${name}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== want) throw new Error(`Sai SHA256 cho ${name}: ${got} ≠ ${want}`);
    writeFileSync(file, buf);
  }
  return file;
}

function extract(tgz, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  // Gói có thư mục gốc "python/": bỏ đi để dest chính là thư mục Python.
  execFileSync('tar', ['xzf', tgz, '-C', dest, '--strip-components=1'], { stdio: 'inherit' });
}

function hostPython() {
  if (!HOST) throw new Error(`Chưa hỗ trợ build trên ${process.platform}-${process.arch}`);
  const dir = path.join(desktop, 'build/host-python');
  const exe = process.platform === 'win32' ? path.join(dir, 'python.exe') : path.join(dir, 'bin/python3');
  return { dir, exe };
}

/** Xóa phần không cần khi chạy (test của thư viện, IDLE, Tk) để app nhẹ hơn. */
function prune(root) {
  const drop = new Set(['tests', 'test', '__pycache__', 'idlelib', 'tkinter', 'turtledemo', 'tcl', 'ensurepip']);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      // Giữ thư mục "testing" của numpy/pandas (được import khi chạy), chỉ bỏ đúng tên trong danh sách.
      if (drop.has(name)) rmSync(p, { recursive: true, force: true });
      else walk(p);
    }
  };
  walk(root);
}

function dirSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

/** Tên dự án Python chuẩn hóa (PEP 503) để so khớp. */
const normalize = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');

/**
 * Khóa gói tùy chọn "Phân tích số liệu" cho một nền tảng: tải wheel (gồm phụ thuộc), bỏ các gói đã
 * có trong Python lõi, ghi tên==phiên bản kèm SHA256 từng file. App cài bằng pip --require-hashes
 * nên chỉ cài đúng các file này. Thử cài vào thư mục tạm để đo dung lượng và chắc chắn cài được.
 */
function lockExtras(target, platforms, coreSite, outDir) {
  const tmp = path.join(desktop, 'build/cache/extras', target);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(path.join(tmp, 'wheels'), { recursive: true });
  const pipArgs = ['--disable-pip-version-check', '--quiet', '--only-binary=:all:', '--implementation', 'cp', '--python-version', PY_MINOR, ...platforms.flatMap((p) => ['--platform', p])];
  execFileSync(host.exe, ['-m', 'pip', 'download', ...pipArgs, '-d', path.join(tmp, 'wheels'), '-r', path.join(desktop, 'python-extras.txt')], { stdio: 'inherit' });
  const core = new Set(
    readdirSync(coreSite)
      .filter((n) => n.endsWith('.dist-info'))
      .map((n) => normalize(n.replace(/-[^-]+\.dist-info$/, ''))),
  );
  const lines = [];
  let download = 0;
  const kept = [];
  for (const file of readdirSync(path.join(tmp, 'wheels')).sort()) {
    const [name, version] = file.split('-');
    if (core.has(normalize(name))) continue; // đã có trong Python lõi
    const buf = readFileSync(path.join(tmp, 'wheels', file));
    download += buf.length;
    kept.push(path.join(tmp, 'wheels', file));
    lines.push(`${name}==${version} --hash=sha256:${createHash('sha256').update(buf).digest('hex')}`);
  }
  // Thử cài đúng như app sẽ cài (không mạng, chỉ từ các file đã khóa) để đo dung lượng sau khi cài.
  const lock = path.join(tmp, 'data.lock');
  writeFileSync(lock, lines.join('\n') + '\n');
  execFileSync(host.exe, ['-m', 'pip', 'install', ...pipArgs, '--no-deps', '--require-hashes', '--no-index', '--find-links', path.join(tmp, 'wheels'), '--target', path.join(tmp, 'site'), '-r', lock], { stdio: 'inherit' });
  prune(path.join(tmp, 'site'));
  const installed = dirSize(path.join(tmp, 'site'));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'data.lock'), lines.join('\n') + '\n');
  writeFileSync(
    path.join(outDir, 'data.json'),
    JSON.stringify(
      {
        id: 'data',
        title: 'Gói phân tích số liệu',
        packages: ['numpy', 'pandas', 'scipy', 'matplotlib'],
        downloadBytes: download,
        installedBytes: installed,
      },
      null,
      2,
    ),
  );
  console.log(`  gói tùy chọn: ${kept.length} file, tải ${(download / 1e6).toFixed(0)} MB, sau khi cài ${(installed / 1e6).toFixed(0)} MB`);
}

const requested = process.argv.slice(2);
if (!requested.length || requested.some((t) => !TARGETS[t])) {
  console.error(`Dùng: node scripts/fetch-python.mjs ${Object.keys(TARGETS).join('|')} …`);
  process.exit(1);
}

// Python của máy build, chỉ dùng để chạy pip cài wheel cho nền tảng đích.
const host = hostPython();
if (!existsSync(host.exe)) {
  console.log('▸ Python cho máy build (chạy pip)');
  extract(await download(HOST), host.dir);
}

const requirements = path.join(desktop, 'python-requirements.txt');
for (const target of requested) {
  const { triple, platforms } = TARGETS[target];
  const dest = path.join(outRoot, target);
  console.log(`▸ Python ${PY} cho ${target}`);
  extract(await download(triple), dest);
  const site = target.startsWith('win') ? path.join(dest, 'Lib/site-packages') : path.join(dest, `lib/python${PY_MINOR}/site-packages`);
  console.log(`  cài thư viện vào ${path.relative(desktop, site)}`);
  execFileSync(
    host.exe,
    [
      '-m', 'pip', 'install',
      '--disable-pip-version-check', '--no-compile', '--quiet',
      '--only-binary=:all:', '--implementation', 'cp', '--python-version', PY_MINOR,
      ...platforms.flatMap((p) => ['--platform', p]),
      '--target', site, '--upgrade',
      '-r', requirements,
    ],
    { stdio: 'inherit' },
  );
  // Giữ pip: app dùng nó để cài gói tùy chọn (phân tích số liệu) khi người dùng đồng ý.
  prune(dest);
  lockExtras(target, platforms, site, path.join(dest, 'packs'));
  // Header C và thư viện liên kết chỉ dùng khi biên dịch extension.
  for (const dir of ['include', 'libs']) rmSync(path.join(dest, dir), { recursive: true, force: true });
  if (!target.startsWith('win') && !existsSync(path.join(dest, 'bin/python'))) symlinkSync('python3', path.join(dest, 'bin/python'));
  console.log(`  xong: ${(dirSize(dest) / 1e6).toFixed(0)} MB`);
}
