import type { AgentEvent } from '@ide/shared';
import { describe, expect, it } from 'vitest';
import { TurnNotifier, plainText, trailingQuestion } from '../src/notify.js';

const user: AgentEvent = { kind: 'user', id: 'u1', text: 'tóm tắt', files: [] };
const text = (t: string): AgentEvent => ({ kind: 'block', messageId: 'm', index: 0, block: { type: 'text', text: t } });
const tool: AgentEvent = { kind: 'block', messageId: 'm', index: 1, block: { type: 'tool_use', id: 't', name: 'Write', input: {} } };
const done: AgentEvent = { kind: 'result', isError: false, durationMs: 10 };

function run(events: AgentEvent[]) {
  const n = new TurnNotifier(() => 'Sinh học');
  return events.map((e) => n.next(e)).filter(Boolean);
}

describe('thông báo khi Claude cần người dùng', () => {
  it('trả lời xong: tiêu đề và đoạn đầu câu trả lời (bỏ Markdown)', () => {
    const [note] = run([user, text('## Tóm tắt\n**Chương 1** nói về [tế bào](<a.pdf#page=2>).'), done]);
    expect(note).toEqual({ kind: 'done', title: 'Claude đã trả lời xong', body: 'Sinh học: Tóm tắt Chương 1 nói về tế bào.' });
  });

  it('làm xong việc có dùng công cụ', () => {
    expect(run([user, tool, text('Đã tạo đề thi.'), done])[0]).toMatchObject({ kind: 'done', title: 'Claude đã làm xong' });
  });

  it('kết thúc bằng câu hỏi: báo đang hỏi kèm câu hỏi', () => {
    const [note] = run([user, text('Tôi đã đọc xong.\n\nĐề có 3 phần. Bạn muốn **mấy câu** mỗi phần?'), done]);
    expect(note).toEqual({ kind: 'question', title: 'Claude đang hỏi bạn', body: 'Sinh học: Bạn muốn mấy câu mỗi phần?' });
  });

  it('cần cho phép: nói rõ thao tác', () => {
    const [note] = run([
      user,
      { kind: 'permission', id: 'p', toolName: 'Edit', input: { file_path: '/home/a/Desktop/ghi chú.md' }, outside: ['/home/a/Desktop/ghi chú.md'] },
    ]);
    expect(note).toMatchObject({ kind: 'permission', title: 'Claude cần bạn cho phép', body: 'Sinh học: Đụng tới file ngoài thư mục đang mở: ghi chú.md' });
    expect(run([{ kind: 'permission', id: 'p', toolName: 'Bash', input: { command: 'ls', description: 'Liệt kê file' } }])[0]).toMatchObject({
      body: 'Sinh học: Liệt kê file',
    });
  });

  it('người dùng bấm dừng: không báo; lỗi: báo lỗi', () => {
    expect(run([user, text('Đang làm'), { ...done, interrupted: true }])).toEqual([]);
    expect(run([user, { kind: 'result', isError: true, durationMs: 1, message: 'Hết hạn mức' }])[0]).toMatchObject({ kind: 'error', body: 'Sinh học: Hết hạn mức' });
  });

  it('câu trả lời dài được cắt ngắn', () => {
    const body = run([user, text('a '.repeat(300)), done])[0]!.body;
    expect(body.length).toBeLessThanOrEqual(160);
    expect(body.endsWith('…')).toBe(true);
  });

  it('nhận ra câu hỏi cuối, bỏ qua dấu hỏi ở giữa', () => {
    expect(trailingQuestion('Vì sao trời xanh? Vì tán xạ.')).toBeNull();
    expect(trailingQuestion('Xong rồi.\n- Bạn có muốn xuất Word không?')).toBe('Bạn có muốn xuất Word không?');
    expect(plainText('`code` và *nghiêng*')).toBe('code và nghiêng');
  });
});
