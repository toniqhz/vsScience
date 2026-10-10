import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TreeNode, TreeResponse } from '@ide/shared';
import { buildApp } from '../src/app.js';

const TOKEN = 'test-token-0123456789abcdefghijkl';
let base: string;
let root: string;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let FAKE_CLAUDE = '';

/** CLI "claude" giả: mô phỏng auth status / login / logout, lưu trạng thái trong một file đánh dấu. */
const FAKE_CLAUDE_SRC = `#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');
const marker = process.env.FAKE_CLAUDE_MARKER;
const [, , cmd, sub] = process.argv;
if (cmd !== 'auth') process.exit(2);
if (sub === 'status') {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log(JSON.stringify({ loggedIn: true, authMethod: 'api_key' }));
  } else if (fs.existsSync(marker)) {
    console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'ban@example.com', subscriptionType: 'pro', orgName: 'Cá nhân' }));
  } else {
    console.log(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
    process.exit(1);
  }
} else if (sub === 'login') {
  execFileSync(process.env.BROWSER, ['https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5555%2Fcallback']);
  process.stdout.write("Opening browser to sign in\\u2026\\nIf the browser didn't open, visit: \\u001b]8;;https://claude.com/cai/oauth/authorize?code=true\\u0007link\\u001b]8;;\\u0007\\nPaste code here if prompted > ");
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line === 'dung') { fs.writeFileSync(marker, '1'); console.log('Login successful'); process.exit(0); }
      process.stdout.write('Invalid code. Please make sure the full code was copied.\\nPaste code here if prompted > ');
    }
  });
} else if (sub === 'logout') {
  fs.rmSync(marker, { force: true });
}
`;

const auth = { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:4317' };
const opened: string[] = [];

const windows: string[] = [];
const revealed: [string, boolean][] = [];

beforeAll(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'ide-test-')));
  root = path.join(base, 'ws');
  mkdirSync(path.join(root, 'Chương 10'), { recursive: true });
  mkdirSync(path.join(root, 'Chương 2'));
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'Chương 2', 'sach.pdf'), '%PDF-1.4 fake');
  writeFileSync(path.join(root, 'de-thi.docx'), 'docx');
  writeFileSync(path.join(root, 'ngan-hang.xlsx'), 'xlsx');
  writeFileSync(path.join(root, 'ghi-chu.md'), '# Ghi chú');
  writeFileSync(path.join(root, 'anh.png'), 'png');
  writeFileSync(path.join(root, 'cai-dat.exe'), 'MZ');
  writeFileSync(path.join(root, 'desktop.ini'), 'hệ thống');
  writeFileSync(path.join(root, '~$de-thi.docx'), 'lock');
  writeFileSync(path.join(root, '.an.pdf'), 'hidden');
  writeFileSync(path.join(base, 'bi-mat.pdf'), 'outside');
  symlinkSync(path.join(base, 'bi-mat.pdf'), path.join(root, 'link.pdf'));
  FAKE_CLAUDE = path.join(base, 'fake-claude.cjs');
  writeFileSync(FAKE_CLAUDE, FAKE_CLAUDE_SRC, { mode: 0o755 });
  process.env.FAKE_CLAUDE_MARKER = path.join(base, 'logged-in');
  ({ app } = await buildApp(
    {
      initialWorkspace: root,
      token: TOKEN,
      webDist: path.join(base, 'none'),
      statePath: path.join(base, 'state.json'),
      claudeBin: FAKE_CLAUDE,
      snapshotsDir: path.join(base, 'snapshots'),
      usePolling: false,
    },
    { watch: false, openExternal: async (abs) => void opened.push(abs), openWindow: async (dir) => void windows.push(dir), reveal: async (abs, isDir) => void revealed.push([abs, isDir]), readPdf: async (files) => new Map(files.map((f) => [f, null])) },
  ));
});

afterAll(async () => {
  await app.close();
  rmSync(base, { recursive: true, force: true });
});

describe('xác thực', () => {
  it('health không cần token', async () => {
    const res = await app.inject({ url: '/api/health', headers: { host: '127.0.0.1:4317' } });
    expect(res.statusCode).toBe(200);
  });

  it('từ chối khi thiếu hoặc sai token', async () => {
    const none = await app.inject({ url: '/api/tree', headers: { host: '127.0.0.1:4317' } });
    expect(none.statusCode).toBe(401);
    const wrong = await app.inject({
      url: '/api/tree',
      headers: { host: '127.0.0.1:4317', authorization: 'Bearer sai' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('nhận token qua query', async () => {
    const res = await app.inject({ url: `/api/workspace?token=${TOKEN}`, headers: { host: 'localhost:5173' } });
    expect(res.statusCode).toBe(200);
  });

  it('từ chối Host lạ (DNS rebinding)', async () => {
    const res = await app.inject({ url: '/api/tree', headers: { ...auth, host: 'evil.example:4317' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('cây thư mục', () => {
  it('hiện mọi file như File Explorer (trừ file ẩn và file hệ thống), sắp xếp tự nhiên', async () => {
    const res = await app.inject({ url: '/api/tree', headers: auth });
    const body = res.json<TreeResponse>();
    const names = (body.root.children ?? []).map((n: TreeNode) => n.name);
    expect(names).toEqual(['Chương 2', 'Chương 10', 'anh.png', 'cai-dat.exe', 'de-thi.docx', 'ghi-chu.md', 'ngan-hang.xlsx']);
    const chuong2 = body.root.children?.[0];
    expect(chuong2?.children?.[0]).toMatchObject({ id: 'Chương 2/sach.pdf', kind: 'pdf', type: 'file' });
  });
});

describe('đọc file', () => {
  it('trả nội dung PDF', async () => {
    const res = await app.inject({
      url: `/api/file?path=${encodeURIComponent('Chương 2/sach.pdf')}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body).toBe('%PDF-1.4 fake');
  });

  it.each([
    ['../bi-mat.pdf', 400],
    ['Chương 2/../../bi-mat.pdf', 400],
    ['/tmp/bi-mat.pdf', 400],
    ['.an.pdf', 400],
    ['link.pdf', 404],
    ['khong-co.pdf', 404],
    ['Chương 2', 415],
  ])('chặn %s', async (p, status) => {
    const res = await app.inject({ url: `/api/file?path=${encodeURIComponent(p)}`, headers: auth });
    expect(res.statusCode).toBe(status);
  });
});

describe('mở bằng ứng dụng ngoài', () => {
  it('mở file Word/Excel trong thư mục làm việc bằng ứng dụng mặc định', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/file/open-external', headers: auth, payload: { path: 'de-thi.docx' } });
    expect(res.statusCode).toBe(200);
    expect(opened).toEqual([path.join(root, 'de-thi.docx')]);
  });

  it.each([
    ['../bi-mat.pdf', 400],
    ['link.pdf', 404],
    ['Chương 2', 415],
    ['cai-dat.exe', 415],
  ])('không mở %s', async (p, status) => {
    opened.length = 0;
    const res = await app.inject({ method: 'POST', url: '/api/file/open-external', headers: auth, payload: { path: p } });
    expect(res.statusCode).toBe(status);
    expect(opened).toEqual([]);
  });
});

describe('tạo file và thư mục', () => {
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: auth, payload });

  it('tạo thư mục mới', async () => {
    const res = await post('/api/fs/folder', { parent: 'Chương 2', name: 'Bài tập' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ path: 'Chương 2/Bài tập' });
    expect((await post('/api/fs/folder', { parent: 'Chương 2', name: 'Bài tập' })).statusCode).toBe(409);
  });

  it('tạo file Word (mặc định khi không có đuôi) và Excel hợp lệ', async () => {
    const docx = await post('/api/fs/file', { parent: '', name: 'Đề mới' });
    expect(docx.json()).toEqual({ path: 'Đề mới.docx' });
    const xlsx = await post('/api/fs/file', { parent: 'Chương 2', name: 'Điểm.xlsx' });
    expect(xlsx.statusCode).toBe(201);
    const { unzipSync, strFromU8 } = await import('fflate');
    const files = unzipSync(readFileSync(path.join(root, 'Chương 2', 'Điểm.xlsx')));
    expect(Object.keys(files)).toContain('xl/worksheets/sheet1.xml');
    expect(strFromU8(files['[Content_Types].xml']!)).toContain('spreadsheetml');
    expect((await post('/api/fs/file', { parent: '', name: 'Đề mới.docx' })).statusCode).toBe(409);
  });

  it.each([
    ['', 'ghi-chu.pdf', 400],
    ['', 'a/b.docx', 400],
    ['', '../x.docx', 400],
    ['', '.an.docx', 400],
    ['', 'CON.docx', 400],
    ['../', 'x.docx', 400],
    ['khong-co', 'x.docx', 404],
  ])('từ chối parent=%s name=%s', async (parent, name, status) => {
    expect((await post('/api/fs/file', { parent, name })).statusCode).toBe(status);
  });
});

describe('tìm trong nội dung file', () => {
  it('trả về file và chỗ khớp, không cần gõ dấu', async () => {
    writeFileSync(path.join(root, 'ghi chú.md'), '# Ôn tập\nPhản ứng chuỗi polymerase (PCR)');
    const res = await app.inject({ url: `/api/search?q=${encodeURIComponent('phan ung')}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const md = body.files.find((f: { path: string }) => f.path === 'ghi chú.md');
    expect(md).toMatchObject({ kind: 'markdown', total: 1, matches: [{ loc: 'Dòng 2', target: { row: 1, occurrence: 0 } }] });
    rmSync(path.join(root, 'ghi chú.md'));
  });
});

describe('menu chuột phải: hiện trong thư mục, xóa', () => {
  const post = (url: string, p: string) => app.inject({ method: 'POST', url, headers: auth, payload: { path: p } });

  it('hiện file (chọn trong thư mục cha), thư mục và chính thư mục làm việc', async () => {
    revealed.length = 0;
    expect((await post('/api/fs/reveal', 'Chương 2/sach.pdf')).statusCode).toBe(200);
    expect((await post('/api/fs/reveal', 'Chương 2')).statusCode).toBe(200);
    expect((await post('/api/fs/reveal', '')).statusCode).toBe(200);
    expect(revealed).toEqual([
      [path.join(root, 'Chương 2', 'sach.pdf'), false],
      [path.join(root, 'Chương 2'), true],
      [root, true],
    ]);
    expect((await post('/api/fs/reveal', '../bi-mat.pdf')).statusCode).toBe(400);
  });

  it('xóa file, thư mục; xóa liên kết thì không đụng tới file nó trỏ tới; không xóa ra ngoài', async () => {
    mkdirSync(path.join(root, 'Xóa', 'con'), { recursive: true });
    writeFileSync(path.join(root, 'Xóa', 'con', 'a.md'), 'a');
    writeFileSync(path.join(root, 'xoa.md'), 'x');
    symlinkSync(path.join(base, 'bi-mat.pdf'), path.join(root, 'lien-ket.pdf'));
    expect((await post('/api/fs/delete', 'xoa.md')).json()).toEqual({ ok: true, trashed: false });
    expect(existsSync(path.join(root, 'xoa.md'))).toBe(false);
    expect((await post('/api/fs/delete', 'Xóa')).statusCode).toBe(200);
    expect(existsSync(path.join(root, 'Xóa'))).toBe(false);
    expect((await post('/api/fs/delete', 'lien-ket.pdf')).statusCode).toBe(200);
    expect(existsSync(path.join(base, 'bi-mat.pdf'))).toBe(true);
    for (const [p, code] of [['khong-co.md', 404], ['../bi-mat.pdf', 400], ['/', 400], ['.', 400]] as const) {
      expect((await post('/api/fs/delete', p)).statusCode, p).toBe(code);
    }
    expect(existsSync(path.join(base, 'bi-mat.pdf'))).toBe(true);
    expect(existsSync(root)).toBe(true);
  });
});

describe('mở thư mục', () => {
  it('duyệt thư mục con, ẩn thư mục ẩn', async () => {
    const res = await app.inject({ url: `/api/fs/dirs?path=${encodeURIComponent(root)}`, headers: auth });
    const body = res.json<{ path: string; parent: string; dirs: { name: string }[] }>();
    expect(body.parent).toBe(base);
    expect(body.dirs.map((d) => d.name)).toEqual(['Chương 2', 'Chương 10']);
  });

  it('đổi thư mục làm việc và nhớ thư mục gần đây', async () => {
    const other = path.join(base, 'khac');
    mkdirSync(other);
    writeFileSync(path.join(other, 'moi.pdf'), 'x');
    const res = await app.inject({ method: 'POST', url: '/api/workspace', headers: auth, payload: { path: other } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ root: other, name: 'khac', recent: [root] });
    const tree = (await app.inject({ url: '/api/tree', headers: auth })).json<TreeResponse>();
    expect(tree.root.children?.map((c) => c.name)).toEqual(['moi.pdf']);
    // file của thư mục cũ không còn đọc được
    const old = await app.inject({ url: `/api/file?path=${encodeURIComponent('Chương 2/sach.pdf')}`, headers: auth });
    expect(old.statusCode).toBe(404);
    // quay lại để không ảnh hưởng test khác
    await app.inject({ method: 'POST', url: '/api/workspace', headers: auth, payload: { path: root } });
  });

  it('mở thư mục trong cửa sổ mới (app desktop), thư mục đang mở giữ nguyên', async () => {
    const other = path.join(base, 'cua-so');
    mkdirSync(other);
    const res = await app.inject({ method: 'POST', url: '/api/window', headers: auth, payload: { path: other } });
    expect(res.statusCode).toBe(200);
    expect(windows).toEqual([other]);
    expect((await app.inject({ url: '/api/workspace', headers: auth })).json()).toMatchObject({ root });
    const bad = await app.inject({ method: 'POST', url: '/api/window', headers: auth, payload: { path: '/khong/co' } });
    expect(bad.statusCode).toBe(404);
  });

  it.each([
    ['tuong-doi', 400],
    ['/', 400],
    ['/khong/co/thu/muc', 404],
  ])('từ chối mở %s', async (p, status) => {
    const res = await app.inject({ method: 'POST', url: '/api/workspace', headers: auth, payload: { path: p } });
    expect(res.statusCode).toBe(status);
  });
});

describe('đăng nhập Claude qua CLI', () => {
  const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: auth, payload });
  const get = (url: string) => app.inject({ url, headers: auth });
  const waitFor = async (pred: () => Promise<boolean>) => {
    for (let i = 0; i < 50 && !(await pred()); i++) await new Promise((r) => setTimeout(r, 100));
  };

  it('ban đầu chưa đăng nhập; không để lộ ANTHROPIC_API_KEY cho CLI', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-khong-duoc-dung';
    const res = await get('/api/auth/status');
    delete process.env.ANTHROPIC_API_KEY;
    expect(res.json()).toMatchObject({ loggedIn: false, method: 'none' });
  });

  it('bắt link tự động (qua BROWSER) và link dự phòng, rồi đăng nhập bằng mã', async () => {
    const start = (await post('/api/auth/login')).json();
    expect(start).toMatchObject({
      state: 'waiting',
      autoUrl: 'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5555%2Fcallback',
      manualUrl: 'https://claude.com/cai/oauth/authorize?code=true',
    });

    await post('/api/auth/login/code', { code: 'sai' });
    await waitFor(async () => (await get('/api/auth/login')).json().message !== null);
    expect((await get('/api/auth/login')).json().message).toContain('Mã không đúng');

    await post('/api/auth/login/code', { code: ' dung ' });
    await waitFor(async () => (await get('/api/auth/login')).json().state === 'success');
    expect((await get('/api/auth/login')).json().state).toBe('success');
    expect((await get('/api/auth/status')).json()).toEqual({
      loggedIn: true,
      method: 'claude.ai',
      email: 'ban@example.com',
      plan: 'pro',
      orgName: 'Cá nhân',
    });
  });

  it('hủy đăng nhập đang chờ; gửi mã khi không có phiên thì báo 409', async () => {
    await post('/api/auth/login');
    expect((await post('/api/auth/login/cancel')).json().state).toBe('idle');
    expect((await post('/api/auth/login/code', { code: 'x' })).statusCode).toBe(409);
  });

  it('đăng xuất', async () => {
    expect((await post('/api/auth/logout')).json()).toMatchObject({ loggedIn: false });
  });

  it('cần token truy cập', async () => {
    const res = await app.inject({ url: '/api/auth/status', headers: { host: '127.0.0.1:4317' } });
    expect(res.statusCode).toBe(401);
  });
});
