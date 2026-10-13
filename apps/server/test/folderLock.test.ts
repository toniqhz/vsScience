import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { FastifyInstance } from 'fastify';
import type { AgentQuery, QueryFn } from '../src/agent.js';
import { buildApp } from '../src/app.js';
import { FolderLocks, overlaps } from '../src/folderLock.js';

describe('khóa thư mục', () => {
  it('trùng, cha hoặc con là đụng nhau; thư mục anh em thì không', () => {
    expect(overlaps('/a/Ôn thi', '/a/Ôn thi/')).toBe(true);
    expect(overlaps('/a/Ôn thi', '/a/Ôn thi/Đề thi')).toBe(true);
    expect(overlaps('/a/Ôn thi/Đề thi', '/a/Ôn thi')).toBe(true);
    expect(overlaps('/a/Ôn thi', '/a/Ôn thi 2')).toBe(false);
    expect(overlaps('/a/Ôn thi', '/a/Sinh học')).toBe(false);
    // Tên tiếng Việt dạng tổ hợp (NFD, như macOS trả về) vẫn là cùng thư mục.
    expect(overlaps('/a/Ôn thi', '/a/Ôn thi'.normalize('NFD'))).toBe(true);
  });

  it('giữ, chặn cửa sổ khác, nhả', () => {
    const locks = new FolderLocks();
    let changes = 0;
    locks.subscribe(() => changes++);
    expect(locks.acquire({ id: 'w1', root: '/a/Ôn thi' })).toBeNull();
    expect(locks.acquire({ id: 'w1', root: '/a/Ôn thi' })).toBeNull(); // gửi thêm trong cùng lượt
    expect(locks.acquire({ id: 'w2', root: '/a/Ôn thi/Đề thi' })?.id).toBe('w1');
    expect(locks.acquire({ id: 'w3', root: '/a/Sinh học' })).toBeNull();
    expect(locks.conflict('w2', '/a/Ôn thi/Đề thi')?.id).toBe('w1');
    locks.release('w1');
    expect(locks.conflict('w2', '/a/Ôn thi/Đề thi')).toBeNull();
    expect(changes).toBe(3);
  });
});

const m = (x: unknown) => x as SDKMessage;

describe('hai cửa sổ cùng thư mục', () => {
  const TOKEN = 'test-token-0123456789abcdefghijkl';
  const headers = { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:4317' };
  let base: string;
  let finishTurn: () => void = () => {};
  const focused: string[] = [];
  const locks = new FolderLocks();
  let w1: FastifyInstance;
  let w2: FastifyInstance;

  /** Claude giả: lượt chỉ xong khi test gọi finishTurn(). */
  const queryFn: QueryFn = ({ prompt }) =>
    ({
      async *[Symbol.asyncIterator]() {
        for await (const _ of prompt) {
          await new Promise<void>((r) => (finishTurn = r));
          yield m({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
        }
      },
      interrupt: async () => finishTurn(),
      setModel: async () => {},
      setPermissionMode: async () => {},
      close: () => {},
    }) as unknown as AgentQuery;

  const make = async (name: string, ws: string) =>
    (
      await buildApp(
        {
          initialWorkspace: ws,
          token: TOKEN,
          webDist: path.join(base, 'none'),
          statePath: path.join(base, `${name}.json`),
          claudeBin: '/bin/false',
          snapshotsDir: path.join(base, `snap-${name}`),
          usePolling: false,
        },
        { watch: false, queryFn, folderLocks: locks, focusWindow: () => void focused.push(name) },
      )
    ).app;

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'ide-lock-')));
    mkdirSync(path.join(base, 'Ôn thi', 'Đề thi'), { recursive: true });
    w1 = await make('w1', path.join(base, 'Ôn thi'));
    w2 = await make('w2', path.join(base, 'Ôn thi', 'Đề thi'));
  });

  afterAll(async () => {
    await w1.close();
    await w2.close();
    rmSync(base, { recursive: true, force: true });
  });

  const send = (app: typeof w1) =>
    app.inject({ method: 'POST', url: '/api/agent/message', headers, payload: { text: 'Sửa đề', files: [], model: 'claude-opus-5-5', effort: null, mode: 'auto' } });
  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 10));
  };
  const busy = async (app: typeof w1) => (await app.inject({ url: '/api/agent/lock', headers })).json().busyElsewhere;

  it('Claude đang làm ở cửa sổ 1: cửa sổ 2 (thư mục con) không gửi được, chuyển được sang cửa sổ 1', async () => {
    expect((await send(w1)).statusCode).toBe(200);
    expect(await busy(w2)).toMatchObject({ folder: 'Ôn thi' });
    expect(await busy(w1)).toBeNull();
    const res = await send(w2);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/cửa sổ khác/);
    await w2.inject({ method: 'POST', url: '/api/agent/lock/focus', headers });
    expect(focused).toEqual(['w1']);
  });

  it('trong cửa sổ đang chạy: không chuyển phiên, không tạo phiên mới, không đổi thư mục', async () => {
    expect((await w1.inject({ method: 'POST', url: '/api/agent/clear', headers })).statusCode).toBe(409);
    expect((await w1.inject({ method: 'POST', url: '/api/agent/sessions/open', headers, payload: { id: 'abc' } })).statusCode).toBe(409);
    expect((await w1.inject({ method: 'POST', url: '/api/workspace', headers, payload: { path: base } })).statusCode).toBe(409);
  });

  it('Claude xong: mở khóa cho cửa sổ 2', async () => {
    finishTurn();
    await until(async () => (await busy(w2)) === null);
    expect(await busy(w2)).toBeNull();
    expect((await send(w2)).statusCode).toBe(200);
    expect(await busy(w1)).toMatchObject({ folder: 'Đề thi' });
    finishTurn();
    await until(async () => (await busy(w1)) === null);
    expect((await w1.inject({ method: 'POST', url: '/api/agent/clear', headers })).statusCode).toBe(200);
  });
});
