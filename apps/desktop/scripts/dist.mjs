// Đóng gói app desktop: node scripts/dist.mjs win|mac
//   1. build giao diện web   2. bundle tiến trình chính
//   3. chuẩn bị tài nguyên (web, hồ sơ Claude, Claude CLI đúng hệ điều hành)   4. electron-builder
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const target = process.argv[2];
if (target !== 'win' && target !== 'mac') {
  console.error('Dùng: node scripts/dist.mjs win|mac');
  process.exit(1);
}
if (target === 'mac' && process.platform !== 'darwin') {
  console.error('Bản macOS phải build trên máy Mac (hoặc GitHub Actions macos): cần hdiutil và ký app.');
  process.exit(1);
}

const desktop = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(desktop, '../..');
const build = path.join(desktop, 'build');
const resources = path.join(build, 'resources');
const run = (cmd, args, cwd = repo) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

console.log('\n▸ Build giao diện web');
run('pnpm', ['--filter', '@ide/web', 'build']);

console.log('\n▸ Bundle tiến trình chính');
run('node', [path.join(desktop, 'scripts/bundle.mjs')]);

console.log('\n▸ Chuẩn bị tài nguyên');
rmSync(resources, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
cpSync(path.join(repo, 'apps/web/dist'), path.join(resources, 'web'), { recursive: true });
const profile = path.join(repo, 'claude-code-khoa-hoc/claude-code-khoa-hoc');
if (existsSync(profile)) {
  // Chỉ lấy phần hồ sơ (CLAUDE.md, .claude/agents, .claude/output-styles), bỏ thư mục dữ liệu mẫu.
  mkdirSync(path.join(resources, 'profile'), { recursive: true });
  cpSync(path.join(profile, 'CLAUDE.md'), path.join(resources, 'profile/CLAUDE.md'));
  cpSync(path.join(profile, '.claude'), path.join(resources, 'profile/.claude'), { recursive: true });
}

// Claude CLI: gói nhị phân riêng cho từng hệ điều hành, cùng phiên bản với Agent SDK đang dùng.
const require = createRequire(path.join(repo, 'apps/server/package.json'));
// Gói SDK không export ./package.json: tìm từ file chính ngược lên thư mục gói.
let sdkDir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
while (!existsSync(path.join(sdkDir, 'package.json'))) sdkDir = path.dirname(sdkDir);
const sdkVersion = JSON.parse(readFileSync(path.join(sdkDir, 'package.json'), 'utf8')).version;
console.log(`  Claude Agent SDK ${sdkVersion}`);
const platforms = target === 'win' ? [['win32', 'x64', 'win']] : [['darwin', 'arm64', 'mac'], ['darwin', 'x64', 'mac']];
const cache = path.join(build, 'cache');
mkdirSync(cache, { recursive: true });
for (const [platform, arch, os] of platforms) {
  const pkg = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}@${sdkVersion}`;
  const tgz = path.join(cache, `claude-agent-sdk-${platform}-${arch}-${sdkVersion}.tgz`);
  if (!existsSync(tgz)) {
    console.log(`  tải ${pkg}`);
    const name = execFileSync('npm', ['pack', pkg, '--pack-destination', cache, '--silent'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }).trim().split('\n').pop();
    cpSync(path.join(cache, name), tgz);
    rmSync(path.join(cache, name));
  }
  const out = path.join(build, 'claude', `${os}-${arch}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  run('tar', ['xzf', tgz, '-C', out, '--strip-components=1', `package/${platform === 'win32' ? 'claude.exe' : 'claude'}`]);
}

console.log('\n▸ Python portable kèm thư viện');
run('node', [path.join(desktop, 'scripts/fetch-python.mjs'), ...platforms.map(([, arch, os]) => `${os}-${arch}`)]);

console.log('\n▸ Đóng gói bằng electron-builder');
// Bộ cài NSIS cần chạy trên Windows (trên Linux phải có Wine); ngoài Windows thì tạo bản zip chạy thẳng.
// Mỗi nền tảng chỉ một bộ cài: .exe (NSIS) cho Windows, .dmg cho macOS.
const winTargets = process.platform === 'win32' ? ['nsis'] : ['zip'];
const args = target === 'win' ? ['--win', ...winTargets, '--x64'] : ['--mac', 'dmg', '--arm64', '--x64'];
run(path.join(desktop, 'node_modules/.bin/electron-builder'), [...args, '--publish', 'never'], desktop);
console.log(`\n✓ Xong. Bộ cài nằm trong ${path.join(desktop, 'release')}`);
