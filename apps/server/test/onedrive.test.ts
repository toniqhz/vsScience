import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloudConflict } from '../src/cloud/drive.js';
import { OneDriveDrive } from '../src/cloud/onedrive.js';

/** Máy chủ giả lập Microsoft Graph (thư mục riêng của app) + máy chủ tải file ở "origin" khác. */
const files = new Map<string, { data: Buffer; etag: number }>();
const seenAuth: { url: string; auth?: string }[] = [];
let graph: Server;
let cdn: Server;
let graphUrl = '';
let cdnUrl = '';
let etagSeq = 1;
const sessions = new Map<string, { path: string; chunks: Buffer[] }>();

const body = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (d) => parts.push(d)).on('end', () => resolve(Buffer.concat(parts)));
  });

beforeAll(async () => {
  cdn = createServer((req, res) => {
    seenAuth.push({ url: `cdn${req.url}`, auth: req.headers.authorization });
    const f = files.get(decodeURIComponent(req.url!.slice(1)));
    if (!f) return res.writeHead(404).end();
    res.writeHead(200).end(f.data);
  });
  await new Promise<void>((r) => cdn.listen(0, '127.0.0.1', r));
  cdnUrl = `http://127.0.0.1:${(cdn.address() as { port: number }).port}`;

  graph = createServer(async (req, res) => {
    seenAuth.push({ url: req.url!, auth: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer tok') return res.writeHead(401).end();
    const u = new URL(req.url!, 'http://x');
    const json = (status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (u.pathname === '/me/drive/special/approot/children') {
      const names = new Set([...files.keys()].map((k) => k.split('/')[0]!));
      return json(200, { value: [...names].map((name) => ({ name, folder: {} })) });
    }
    const m = /^\/me\/drive\/special\/approot:\/(.+?):(\/content|\/createUploadSession)?$/.exec(u.pathname);
    if (!m) return json(400, { error: { message: 'bad path' } });
    const p = decodeURIComponent(m[1]!);
    const f = files.get(p);
    if (req.method === 'GET' && !m[2]) return f ? json(200, { name: p, eTag: `"e${f.etag}"` }) : json(404, { error: { message: 'itemNotFound' } });
    if (req.method === 'GET' && m[2] === '/content') {
      if (!f) return json(404, { error: { message: 'itemNotFound' } });
      return res.writeHead(302, { location: `${cdnUrl}/${encodeURIComponent(p)}` }).end();
    }
    if (req.method === 'PUT' && m[2] === '/content') {
      const data = await body(req);
      if (u.searchParams.get('@microsoft.graph.conflictBehavior') === 'fail' && f) return json(409, { error: { message: 'nameAlreadyExists' } });
      const ifMatch = req.headers['if-match'];
      if (ifMatch && (!f || ifMatch !== `"e${f.etag}"`)) return json(412, { error: { message: 'preconditionFailed' } });
      const etag = etagSeq++;
      files.set(p, { data, etag });
      return json(f ? 200 : 201, { eTag: `"e${etag}"` });
    }
    if (req.method === 'POST' && m[2] === '/createUploadSession') {
      const id = `s${sessions.size}`;
      sessions.set(id, { path: p, chunks: [] });
      return json(200, { uploadUrl: `http://127.0.0.1:${(graph.address() as { port: number }).port}/upload/${id}` });
    }
    if (req.method === 'DELETE') {
      files.delete(p);
      return res.writeHead(204).end();
    }
    json(405, {});
  });
  // Phiên tải lên: không cần mã truy cập (uploadUrl đã kèm quyền).
  const handler = graph.listeners('request')[0] as (req: IncomingMessage, res: import('node:http').ServerResponse) => void;
  graph.removeAllListeners('request');
  graph.on('request', async (req, res) => {
    const up = /^\/upload\/(s\d+)$/.exec(req.url!);
    if (!up) return handler(req, res);
    seenAuth.push({ url: req.url!, auth: req.headers.authorization });
    const s = sessions.get(up[1]!)!;
    s.chunks.push(await body(req));
    const [, , end, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(String(req.headers['content-range']))!.map(Number);
    if (end! + 1 === total) {
      files.set(s.path, { data: Buffer.concat(s.chunks), etag: etagSeq++ });
      return res.writeHead(201, { 'content-type': 'application/json' }).end('{}');
    }
    res.writeHead(202, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((r) => graph.listen(0, '127.0.0.1', r));
  graphUrl = `http://127.0.0.1:${(graph.address() as { port: number }).port}`;
});

afterAll(() => {
  graph.close();
  cdn.close();
});

describe('OneDrive (Microsoft Graph giả lập)', () => {
  const drive = () => new OneDriveDrive(async () => 'tok', graphUrl);

  it('ghi, đọc (qua chuyển hướng, không gửi mã truy cập sang máy chủ khác), ghi có điều kiện', async () => {
    const d = drive();
    expect(await d.read('Ôn thi/.vsscience/manifest.json')).toBeNull();
    const { etag } = await d.write('Ôn thi/.vsscience/manifest.json', Buffer.from('{"v":1}'), { ifMatch: null });
    await expect(d.write('Ôn thi/.vsscience/manifest.json', Buffer.from('x'), { ifMatch: null })).rejects.toBeInstanceOf(CloudConflict);
    const r = await d.read('Ôn thi/.vsscience/manifest.json');
    expect(r?.data.toString()).toBe('{"v":1}');
    expect(r?.etag).toBe(etag);
    expect(seenAuth.filter((s) => s.url.startsWith('cdn')).every((s) => !s.auth)).toBe(true);
    await d.write('Ôn thi/.vsscience/manifest.json', Buffer.from('{"v":2}'), { ifMatch: etag });
    await expect(d.write('Ôn thi/.vsscience/manifest.json', Buffer.from('{"v":3}'), { ifMatch: etag })).rejects.toBeInstanceOf(CloudConflict);
  });

  it('tải lên file nhỏ và file lớn (chia phần), tải về, xóa, liệt kê', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ide-od-')));
    try {
      const small = path.join(dir, 'ghi chú.md');
      const big = path.join(dir, 'sách.pdf');
      writeFileSync(small, '# Ghi chú');
      const bigData = Buffer.alloc(11 * 1024 * 1024, 7);
      bigData.write('đầu file', 0);
      writeFileSync(big, bigData);
      const d = drive();
      await d.upload('Ôn thi/ghi chú.md', small);
      await d.upload('Ôn thi/Sách/sách.pdf', big);
      expect(files.get('Ôn thi/Sách/sách.pdf')?.data.equals(bigData)).toBe(true);
      expect(seenAuth.filter((s) => s.url.startsWith('/upload/')).every((s) => !s.auth)).toBe(true);
      const out = path.join(dir, 'tai-ve.pdf');
      expect(await d.download('Ôn thi/Sách/sách.pdf', out)).toBe(true);
      expect(readFileSync(out).equals(bigData)).toBe(true);
      expect(await d.download('Ôn thi/không có.pdf', out)).toBe(false);
      expect(await d.listFolders()).toEqual(['Ôn thi']);
      await d.remove('Ôn thi/ghi chú.md');
      await d.remove('Ôn thi/không có.md');
      expect(files.has('Ôn thi/ghi chú.md')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mã truy cập hết hạn: lấy mã mới rồi thử lại', async () => {
    let n = 0;
    const d = new OneDriveDrive(async (force) => (force ? 'tok' : (n++, 'cu')), graphUrl);
    expect((await d.read('Ôn thi/.vsscience/manifest.json'))?.data.toString()).toBe('{"v":2}');
    expect(n).toBeGreaterThan(0);
  });
});
