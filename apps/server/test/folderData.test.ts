import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src/artifacts.js';
import { folderDataPath, migrateDir } from '../src/folderData.js';
import { lazyBlockReason } from '../src/lazyGuard.js';
import { FolderSessionStore } from '../src/sessionStore.js';
import { readFolderSettings, writeFolderSettings } from '../src/settings.js';
import { Snapshots } from '../src/snapshots.js';

let base: string;
beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'ide-folderdata-')));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('kho đoạn chat trong thư mục', () => {
  it('ghi, đọc, không ghi trùng uuid, liệt kê, tác tử con, xóa', async () => {
    const store = new FolderSessionStore(path.join(base, 'chat', '.vsscience', 'sessions'));
    const key = { projectKey: '-duong-dan-may-a', sessionId: 'a1b2-c3' };
    expect(await store.load(key)).toBeNull();
    await store.append(key, [{ type: 'user', uuid: 'u1', message: 'Câu 1' }, { type: 'custom-title', title: 'Đề' }]);
    await store.append({ ...key, projectKey: '-may-b-khac' }, [{ type: 'user', uuid: 'u1', message: 'Câu 1' }, { type: 'assistant', uuid: 'u2' }]);
    expect((await store.load(key))!.map((e) => e.uuid ?? e.type)).toEqual(['u1', 'custom-title', 'u2']);
    await store.append({ ...key, subpath: 'subagents/agent-x' }, [{ type: 'user', uuid: 's1' }]);
    expect(await store.listSubkeys(key)).toEqual(['subagents/agent-x']);
    expect((await store.listSessions()).map((s) => s.sessionId)).toEqual(['a1b2-c3']);
    expect(await store.has('a1b2-c3')).toBe(true);
    // Id lạ không thoát ra ngoài thư mục kho.
    await store.append({ projectKey: 'x', sessionId: '../../thoat' }, [{ type: 'user', uuid: 'z' }]);
    expect(existsSync(path.join(base, 'thoat.jsonl'))).toBe(false);
    await store.delete(key);
    expect(await store.load(key)).toBeNull();
    expect(await store.listSubkeys(key)).toEqual([]);
  });
});

describe('chuyển dữ liệu cũ vào .vsscience', () => {
  it('bản lưu cũ trong thư mục dữ liệu của app được chuyển vào thư mục làm việc, giữ nguyên lịch sử', async () => {
    const root = path.join(base, 'Ôn thi');
    mkdirSync(root);
    writeFileSync(path.join(root, 'de.md'), '# Đề');
    const kho = path.join(base, 'kho');
    const s1 = new Snapshots(kho);
    await s1.open(root);
    writeFileSync(path.join(root, 'de.md'), '# Đề mới');
    await s1.snapshot('Sửa đề');
    const inFolder = folderDataPath(root, 'history');
    expect(existsSync(path.join(inFolder, 'HEAD'))).toBe(true);
    expect(readFileSync(folderDataPath(root, 'README.txt'), 'utf8')).toMatch(/VsScience/);

    // Giả lập bản cũ: lịch sử nằm trong thư mục dữ liệu của app.
    const legacy = path.join(kho, createHash('sha1').update(root).digest('hex').slice(0, 16));
    mkdirSync(kho, { recursive: true });
    renameSync(inFolder, legacy);
    const s2 = new Snapshots(kho);
    await s2.open(root);
    expect(existsSync(legacy)).toBe(false);
    expect((await s2.status()).snapshots.map((s) => s.message)).toEqual(['Sửa đề', 'Bản đầu tiên']);
  });

  it('artifact cũ được chuyển vào .vsscience/artifacts', async () => {
    const ID = '0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
    const root = path.join(base, 'Sinh học');
    mkdirSync(root);
    const dir = path.join(base, 'artifacts');
    const legacy = path.join(dir, createHash('sha1').update(root).digest('hex').slice(0, 12));
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, 'index.json'), JSON.stringify({ items: [{ id: ID, source: 'published', title: 'Sơ đồ', url: null, fileName: 'a.html', createdAt: 1, updatedAt: 1 }] }));
    writeFileSync(path.join(legacy, `${ID}.html`), '<h1>Sơ đồ</h1>');
    const store = new ArtifactStore(dir);
    expect((await store.list(root)).map((a) => a.title)).toEqual(['Sơ đồ']);
    expect(await store.content(root, ID)).toBe('<h1>Sơ đồ</h1>');
    expect(existsSync(folderDataPath(root, 'artifacts', `${ID}.html`))).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });

  it('không ghi đè khi chỗ mới đã có', async () => {
    const a = path.join(base, 'm', 'a');
    const b = path.join(base, 'm', 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    expect(await migrateDir(a, b)).toBe(false);
    expect(existsSync(a)).toBe(true);
  });
});

describe('cài đặt của thư mục', () => {
  it('mặc định bật tự lưu; ghi lựa chọn ô chat', () => {
    const root = path.join(base, 'cai-dat');
    mkdirSync(root);
    expect(readFolderSettings(root)).toEqual({ autoSave: true });
    writeFolderSettings(root, { chat: { model: 'claude-opus-5-5', effort: 'high', mode: 'auto' } });
    writeFolderSettings(root, { autoSave: false });
    expect(readFolderSettings(root)).toEqual({ autoSave: false, chat: { model: 'claude-opus-5-5', effort: 'high', mode: 'auto' } });
  });
});

describe('Lười biếng', () => {
  it('chặn xóa dữ liệu của app', () => {
    expect(lazyBlockReason('Bash', { command: 'rm -rf .vsscience' }, [])).toMatch(/dữ liệu của app/);
    expect(lazyBlockReason('Bash', { command: 'ls .vsscience' }, [])).toBeNull();
  });
});
