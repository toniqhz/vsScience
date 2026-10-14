import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { FastifyInstance } from 'fastify';
import type { ChangesResponse } from '@ide/shared';
import type { AgentQuery, QueryFn } from '../src/agent.js';
import { buildApp } from '../src/app.js';
import { cleanTitle, fallbackTitle, fallbackVerdict, parseVerdict } from '../src/turnSummary.js';

const m = (x: unknown) => x as SDKMessage;

describe('đánh giá lượt trước khi lưu', () => {
  it('đọc kết quả JSON của Claude', () => {
    expect(parseVerdict('{"xong": true, "tieu_de": "Soạn 20 câu ôn tập quang hợp."}')).toEqual({ done: true, title: 'Soạn 20 câu ôn tập quang hợp' });
    expect(parseVerdict('Kết quả:\n```json\n{"xong": false, "tieu_de": "x"}\n```')?.done).toBe(false);
    expect(parseVerdict('không phải json')).toBeNull();
  });

  it('không hỏi được Claude: kết thúc bằng câu hỏi là chưa xong', () => {
    expect(fallbackVerdict(['Soạn đề 45 phút. Có 3 phần.'], 'Bạn muốn mấy câu mỗi phần?')).toEqual({ done: false, title: 'Soạn đề 45 phút.' });
    expect(fallbackVerdict(['Soạn đề'], 'Đã tạo file đề.').done).toBe(true);
  });

  it('làm sạch và cắt ngắn tiêu đề', () => {
    expect(cleanTitle('## **Tóm tắt chương 3**\nthêm')).toBe('Tóm tắt chương 3');
    expect(fallbackTitle('a'.repeat(200)).length).toBeLessThanOrEqual(90);
  });
});

describe('tự lưu khi Claude xong một việc đủ lớn', () => {
  const TOKEN = 'test-token-0123456789abcdefghijkl';
  const headers = { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:4317' };
  let base: string;
  let ws: string;
  let app: FastifyInstance;
  /** Việc Claude giả làm trong lượt: sửa file và câu trả lời cuối. */
  let turn: { edit?: () => void; answer: string; interrupted?: boolean } = { answer: '' };
  /** Kết luận của Claude Haiku giả. */
  let verdict = { xong: true, tieu_de: 'Soạn đề ôn tập chương quang hợp' };
  const judged: string[] = [];

  const queryFn: QueryFn = ({ prompt }) =>
    ({
      async *[Symbol.asyncIterator]() {
        for await (const _ of prompt) {
          turn.edit?.();
          yield m({ type: 'assistant', parent_tool_use_id: null, message: { id: `a${Date.now()}`, content: [{ type: 'text', text: turn.answer }] } });
          yield m({ type: 'result', subtype: turn.interrupted ? 'error_during_execution' : 'success', is_error: !!turn.interrupted, duration_ms: 1 });
        }
      },
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      close: () => {},
    }) as unknown as AgentQuery;

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'ide-autosave-')));
    ws = path.join(base, 'ws');
    mkdirSync(ws);
    writeFileSync(path.join(ws, 'ghi-chu.md'), Array.from({ length: 30 }, (_, i) => `Dòng ${i + 1}`).join('\n'));
    ({ app } = await buildApp(
      { initialWorkspace: ws, token: TOKEN, webDist: path.join(base, 'none'), statePath: path.join(base, 'cfg', 'state.json'), claudeBin: '/bin/false', snapshotsDir: path.join(base, 'snap'), usePolling: false },
      {
        watch: false,
        queryFn,
        summaryQueryFn: async function* ({ prompt }) {
          judged.push(prompt);
          yield m({ type: 'result', subtype: 'success', result: JSON.stringify(verdict) });
        },
      },
    ));
  });

  afterAll(async () => {
    await app.close();
    rmSync(base, { recursive: true, force: true });
  });

  const send = (text: string) =>
    app.inject({ method: 'POST', url: '/api/agent/message', headers, payload: { text, files: [], model: 'claude-opus-5-5', effort: null, mode: 'auto' } });
  const changes = async () => (await app.inject({ url: '/api/changes', headers })).json() as ChangesResponse;
  const snapshots = async () => (await changes()).snapshots.map((s) => s.message);
  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 300 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 10));
  };
  /** Gửi tin nhắn rồi đợi lượt (và lần tự lưu nếu có) xong. */
  const run = async (text: string) => {
    const before = judged.length;
    await send(text);
    await new Promise((r) => setTimeout(r, 400));
    return judged.length - before;
  };
  const editLines = (n: number) => () => {
    const file = path.join(ws, 'ghi-chu.md');
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < n; i++) lines[i] = `${lines[i]} (sửa ${Date.now()})`;
    writeFileSync(file, lines.join('\n'));
  };

  it('tạo file và làm xong: lưu, mô tả là tóm tắt yêu cầu', async () => {
    await until(async () => (await snapshots()).length > 0);
    turn = { edit: () => writeFileSync(path.join(ws, 'De on tap.md'), '# Đề'), answer: 'Đã soạn xong đề ôn tập.' };
    expect(await run('Đọc giáo trình rồi soạn đề ôn tập chương quang hợp')).toBe(1);
    expect((await snapshots())[0]).toBe('Soạn đề ôn tập chương quang hợp');
    expect((await changes()).files).toEqual([]);
  });

  it('sửa lắt nhắt vài dòng: chưa lưu, không cần đánh giá', async () => {
    const before = await snapshots();
    turn = { edit: editLines(2), answer: 'Đã sửa lỗi chính tả.' };
    expect(await run('Sửa lỗi chính tả dòng 1, 2')).toBe(0);
    expect(await snapshots()).toEqual(before);
    expect((await changes()).files.map((f) => f.path)).toEqual(['ghi-chu.md']);
  });

  it('sửa nhiều nhưng Claude đang hỏi lại: chưa lưu; trả lời xong thì lưu cả đợt', async () => {
    const before = await snapshots();
    turn = { edit: editLines(12), answer: 'Tôi đã viết lại phần mở đầu. Bạn muốn tôi viết tiếp phần kết luận theo hướng nào?' };
    verdict = { xong: false, tieu_de: 'x' };
    expect(await run('Viết lại ghi chú cho mạch lạc')).toBe(1);
    expect(await snapshots()).toEqual(before);

    turn = { edit: editLines(15), answer: 'Đã viết xong toàn bộ ghi chú.' };
    verdict = { xong: true, tieu_de: 'Viết lại ghi chú cho mạch lạc' };
    expect(await run('Theo hướng tóm tắt ngắn gọn')).toBe(1);
    // Claude được xem cả hai tin nhắn (cùng một việc), kể cả lần sửa nhỏ trước đó.
    expect(judged.at(-1)).toContain('Viết lại ghi chú cho mạch lạc');
    expect(judged.at(-1)).toContain('Theo hướng tóm tắt ngắn gọn');
    expect((await snapshots())[0]).toBe('Viết lại ghi chú cho mạch lạc');
    expect((await snapshots()).length).toBe(before.length + 1);
  });

  it('bấm dừng / lỗi giữa chừng: chưa lưu', async () => {
    const before = await snapshots();
    turn = { edit: () => writeFileSync(path.join(ws, 'Nhap.md'), 'dở'), answer: 'Đang làm…', interrupted: true };
    expect(await run('Soạn bài tập')).toBe(0);
    expect(await snapshots()).toEqual(before);
  });

  it('tắt tự lưu trong cài đặt: không lưu', async () => {
    expect((await app.inject({ url: '/api/settings', headers })).json()).toMatchObject({ autoSave: true });
    expect((await app.inject({ method: 'POST', url: '/api/settings', headers, payload: { autoSave: false } })).json()).toMatchObject({ autoSave: false });
    const before = await snapshots();
    turn = { edit: () => writeFileSync(path.join(ws, 'Khac.md'), 'mới'), answer: 'Xong.' };
    verdict = { xong: true, tieu_de: 'Tạo file khác' };
    expect(await run('Tạo file khác')).toBe(0);
    expect(await snapshots()).toEqual(before);
    expect((await app.inject({ url: '/api/settings', headers })).json()).toMatchObject({ autoSave: false });
  });
});
