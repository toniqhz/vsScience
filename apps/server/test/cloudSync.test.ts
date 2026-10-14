import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CloudStatus } from '@ide/shared';
import { buildApp } from '../src/app.js';
import type { Manifest } from '../src/cloud/sync.js';

describe('đồng bộ thư mục lên ổ đám mây (ổ thử nghiệm)', () => {
  const TOKEN = 'test-token-0123456789abcdefghijkl';
  const headers = { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:4317' };
  let base: string;
  let ws: string;
  let cloud: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'ide-cloud-')));
    ws = path.join(base, 'Ôn thi');
    cloud = path.join(base, 'cloud');
    mkdirSync(path.join(ws, 'Đề thi'), { recursive: true });
    mkdirSync(cloud);
    writeFileSync(path.join(ws, 'ghi chú.md'), '# Ghi chú');
    writeFileSync(path.join(ws, 'Đề thi', 'de-1.docx'), 'docx 1');
    writeFileSync(path.join(ws, 'cai-dat.exe'), 'không đồng bộ');
    ({ app } = await buildApp(
      { initialWorkspace: ws, token: TOKEN, webDist: path.join(base, 'none'), statePath: path.join(base, 'cfg', 'state.json'), claudeBin: '/bin/false', snapshotsDir: path.join(base, 'cfg', 'snap'), usePolling: false },
      { watch: false, cloudLocalDir: cloud, cloudDevice: 'Laptop A' },
    ));
  });
  afterAll(async () => {
    await app.close();
    rmSync(base, { recursive: true, force: true });
  });

  const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers, payload });
  const status = async () => (await app.inject({ url: '/api/cloud', headers })).json() as CloudStatus;
  const manifest = () => JSON.parse(readFileSync(path.join(cloud, 'Ôn thi', '.vsscience', 'manifest.json'), 'utf8')) as Manifest;
  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 300 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 10));
  };
  const synced = () => until(async () => ['synced', 'error', 'behind'].includes((await status()).sync.state));
  const snapshot = async (message: string) => {
    expect((await post('/api/changes/snapshot', { message })).json().saved).toBe(true);
    await until(async () => (await status()).sync.state === 'syncing');
    await synced();
  };

  it('chưa kết nối thì không bật được; kết nối ổ thử nghiệm', async () => {
    expect((await status()).providers.map((p) => [p.id, p.available, p.account])).toEqual([
      ['onedrive', true, null],
      ['gdrive', false, null],
      ['local', true, null],
    ]);
    expect((await post('/api/cloud/folder', { enabled: true, provider: 'local' })).statusCode).toBe(409);
    await post('/api/cloud/connect', { provider: 'local' });
    expect((await status()).providers.find((p) => p.id === 'local')?.account).toEqual({ name: 'Thử nghiệm' });
  });

  it('bật đồng bộ: đẩy lên file thường, lịch sử, cài đặt; bỏ file không phải tài liệu', async () => {
    const res = (await post('/api/cloud/folder', { enabled: true, provider: 'local' })).json() as CloudStatus;
    expect(res.folder).toEqual({ provider: 'local', remoteName: 'Ôn thi' });
    await synced();
    expect((await status()).sync.state).toBe('synced');
    expect(readFileSync(path.join(cloud, 'Ôn thi', 'Đề thi', 'de-1.docx'), 'utf8')).toBe('docx 1');
    expect(existsSync(path.join(cloud, 'Ôn thi', 'cai-dat.exe'))).toBe(false);
    const m = manifest();
    expect(Object.keys(m.files).sort()).toEqual(['Đề thi/de-1.docx', 'ghi chú.md'].sort());
    expect(Object.keys(m.data)).toContain('settings.json');
    expect(m.packs).toHaveLength(1);
    expect(m.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('bản lưu mới: chỉ đẩy phần đổi, xóa file đã xóa, thêm một gói lịch sử', async () => {
    writeFileSync(path.join(ws, 'ghi chú.md'), '# Ghi chú mới');
    unlinkSync(path.join(ws, 'Đề thi', 'de-1.docx'));
    mkdirSync(path.join(ws, '.vsscience', 'sessions'), { recursive: true });
    writeFileSync(path.join(ws, '.vsscience', 'sessions', 'abc.jsonl'), '{"type":"user"}\n');
    const before = manifest();
    await snapshot('Sửa ghi chú');
    const m = manifest();
    expect(readFileSync(path.join(cloud, 'Ôn thi', 'ghi chú.md'), 'utf8')).toBe('# Ghi chú mới');
    expect(existsSync(path.join(cloud, 'Ôn thi', 'Đề thi', 'de-1.docx'))).toBe(false);
    expect(Object.keys(m.files)).toEqual(['ghi chú.md']);
    expect(m.data['sessions/abc.jsonl']).toBeDefined();
    expect(m.packs).toHaveLength(2);
    expect(m.head).not.toBe(before.head);
  });

  it('các gói lịch sử dựng lại được kho bản lưu ở máy khác', async () => {
    const m = manifest();
    const gitdir = path.join(base, 'may-b', 'history');
    await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
    mkdirSync(path.join(gitdir, 'objects', 'pack'), { recursive: true });
    for (const name of m.packs) {
      const dest = path.join(gitdir, 'objects', 'pack', `pack-${name.replace(/\.pack$/, '')}.pack`);
      writeFileSync(dest, readFileSync(path.join(cloud, 'Ôn thi', '.vsscience', 'history', name)));
      await git.indexPack({ fs, dir: path.dirname(gitdir), gitdir, filepath: path.relative(path.dirname(gitdir), dest) });
    }
    const log = await git.log({ fs, gitdir, ref: m.head! });
    expect(log.map((c) => c.commit.message.trim())).toEqual(['Sửa ghi chú', 'Bản đầu tiên']);
  });

  describe('máy B', () => {
    let b: FastifyInstance;
    let wsB: string;
    const postB = (url: string, payload: object = {}) => b.inject({ method: 'POST', url, headers, payload });
    const statusB = async () => (await b.inject({ url: '/api/cloud', headers })).json() as CloudStatus;
    const untilState = async (s: () => Promise<CloudStatus>, want: string[]) => until(async () => want.includes((await s()).sync.state));
    const snapshotOn = async (inst: FastifyInstance, st: () => Promise<CloudStatus>, message: string) => {
      expect((await inst.inject({ method: 'POST', url: '/api/changes/snapshot', headers, payload: { message } })).json().saved).toBe(true);
      await until(async () => (await st()).sync.state === 'syncing');
      await untilState(st, ['synced', 'error', 'behind']);
    };
    const log = async (inst: FastifyInstance) =>
      ((await inst.inject({ url: '/api/changes', headers })).json() as { snapshots: { message: string }[] }).snapshots.map((x) => x.message);

    beforeAll(async () => {
      const home = path.join(base, 'may-b-home');
      mkdirSync(home, { recursive: true });
      ({ app: b } = await buildApp(
        { initialWorkspace: home, token: TOKEN, webDist: path.join(base, 'none'), statePath: path.join(base, 'cfg-b', 'state.json'), claudeBin: '/bin/false', snapshotsDir: path.join(base, 'cfg-b', 'snap'), usePolling: false },
        { watch: false, cloudLocalDir: cloud, cloudDevice: 'Laptop B' },
      ));
      await postB('/api/cloud/connect', { provider: 'local' });
    });
    afterAll(async () => {
      await b.close();
    });

    it('thấy thư mục trên ổ và tải về: tài liệu, lịch sử, đoạn chat, đã bật đồng bộ sẵn', async () => {
      const list = (await b.inject({ url: '/api/cloud/folders?provider=local', headers })).json() as { name: string; files: number }[];
      expect(list.map((f) => [f.name, f.files])).toEqual([['Ôn thi', 1]]);
      const parent = path.join(base, 'Tài liệu máy B');
      mkdirSync(parent);
      const res = await postB('/api/cloud/clone', { provider: 'local', name: 'Ôn thi', parent });
      expect(res.statusCode).toBe(200);
      wsB = res.json().path;
      expect(wsB).toBe(path.join(parent, 'Ôn thi'));
      expect(readFileSync(path.join(wsB, 'ghi chú.md'), 'utf8')).toBe('# Ghi chú mới');
      expect(readFileSync(path.join(wsB, '.vsscience', 'sessions', 'abc.jsonl'), 'utf8')).toBe('{"type":"user"}\n');
      expect((await postB('/api/cloud/clone', { provider: 'local', name: 'Ôn thi', parent })).statusCode).toBe(500);
      await postB('/api/workspace', { path: wsB });
      expect((await statusB()).folder).toEqual({ provider: 'local', remoteName: 'Ôn thi' });
      expect(await log(b)).toEqual(['Sửa ghi chú', 'Bản đầu tiên']);
      expect((await b.inject({ url: '/api/changes', headers })).json().files).toEqual([]);
    });

    it('B sửa rồi lưu: đẩy lên; A lấy về (chưa sửa gì nên lấy nhanh)', async () => {
      writeFileSync(path.join(wsB, 'ghi chú.md'), '# Sửa ở máy B');
      writeFileSync(path.join(wsB, 'de-moi.md'), '# Đề mới từ B');
      await snapshotOn(b, statusB, 'B thêm đề mới');
      expect((await statusB()).sync.state).toBe('synced');
      expect(manifest().device).toBe('Laptop B');
      await post('/api/cloud/sync');
      await until(async () => existsSync(path.join(ws, 'de-moi.md')));
      await synced();
      expect(readFileSync(path.join(ws, 'ghi chú.md'), 'utf8')).toBe('# Sửa ở máy B');
      expect(await log(app)).toEqual(['B thêm đề mới', 'Sửa ghi chú', 'Bản đầu tiên']);
      expect((await app.inject({ url: '/api/changes', headers })).json().files).toEqual([]);
    });

    it('hai máy cùng sửa một file: giữ bản máy này, bản máy kia thành "tên (máy X)"; cả hai cùng có bản gộp', async () => {
      writeFileSync(path.join(wsB, 'ghi chú.md'), '# B sửa lần 2');
      await snapshotOn(b, statusB, 'B sửa lần 2');
      writeFileSync(path.join(ws, 'ghi chú.md'), '# A sửa');
      writeFileSync(path.join(ws, 'chi-A.md'), '# Chỉ A có');
      await snapshot('A sửa');
      expect((await status()).sync.state).toBe('synced');
      expect(readFileSync(path.join(ws, 'ghi chú.md'), 'utf8')).toBe('# A sửa');
      expect(readFileSync(path.join(ws, 'ghi chú (máy Laptop B).md'), 'utf8')).toBe('# B sửa lần 2');
      expect((await log(app))[0]).toBe('Gộp thay đổi từ máy «Laptop B»');
      // B lấy bản gộp về.
      await postB('/api/cloud/sync');
      await until(async () => existsSync(path.join(wsB, 'chi-A.md')));
      await untilState(statusB, ['synced', 'error']);
      expect(readFileSync(path.join(wsB, 'ghi chú.md'), 'utf8')).toBe('# A sửa');
      expect(readFileSync(path.join(wsB, 'ghi chú (máy Laptop B).md'), 'utf8')).toBe('# B sửa lần 2');
      expect((await log(b))[0]).toBe('Gộp thay đổi từ máy «Laptop B»');
    });
  });

  it('tắt đồng bộ: bản lưu sau không đẩy lên nữa', async () => {
    const res = (await post('/api/cloud/folder', { enabled: false })).json() as CloudStatus;
    expect(res.folder).toBeNull();
    expect(JSON.parse(readFileSync(path.join(ws, '.vsscience', 'settings.json'), 'utf8')).cloud).toBeUndefined();
  });
});
