import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ArtifactStore, artifactTitle, artifactUrl, createdFilesFromMessages } from '../src/artifacts.js';

const dir = mkdtempSync(path.join(tmpdir(), 'artifacts-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('ArtifactStore', () => {
  it('đọc link và tiêu đề từ kết quả công cụ Artifact', () => {
    expect(artifactUrl('Published: https://claude.ai/code/artifact/0a1b-2c3d (private)')).toBe('https://claude.ai/code/artifact/0a1b-2c3d');
    expect(artifactUrl('không có link')).toBeNull();
    expect(artifactTitle('<html><head><title>Đề cương Sinh 12</title>', '/x/de-cuong.html')).toBe('Đề cương Sinh 12');
    expect(artifactTitle('<p>x</p>', '/x/bang-diem.html', 'Bảng điểm')).toBe('Bảng điểm');
    expect(artifactTitle('<p>x</p>', '/x/bang-diem.html')).toBe('bang-diem');
  });

  it('lưu theo thư mục làm việc, đăng lại cùng link thì cập nhật mục cũ', async () => {
    const store = new ArtifactStore(dir);
    const a = await store.record('/ws/a', { title: 'Bản 1', url: 'https://claude.ai/artifact/abc', fileName: 'p.html', html: '<p>1</p>' });
    await store.record('/ws/b', { title: 'Khác', url: null, fileName: 'q.html', html: '<p>b</p>' });
    const again = await store.record('/ws/a', { title: 'Bản 2', url: 'https://claude.ai/artifact/abc', fileName: 'p.html', html: '<p>2</p>' });
    expect(again.id).toBe(a.id);
    expect((await store.list('/ws/a')).map((x) => x.title)).toEqual(['Bản 2']);
    expect(await store.content('/ws/a', a.id)).toBe('<p>2</p>');
    expect(await store.content('/ws/a', '../../etc/passwd')).toBeNull();
    await store.remove('/ws/a', a.id);
    expect(await store.list('/ws/a')).toEqual([]);
    expect(await store.list('/ws/b')).toHaveLength(1);
  });

  it('file Claude tạo trong thư mục: không trùng, file đã xóa thì rời danh sách', async () => {
    const ws = path.join(dir, 'ws-file');
    mkdirSync(path.join(ws, 'Tóm tắt'), { recursive: true });
    writeFileSync(path.join(ws, 'Tóm tắt', 'chuong-3.md'), '# 3');
    writeFileSync(path.join(ws, 'de.docx'), 'docx');
    const store = new ArtifactStore(path.join(dir, 'kho-file'));
    expect(await store.recordFiles(ws, [{ path: 'Tóm tắt/chuong-3.md' }, { path: 'de.docx' }])).toBe(true);
    expect(await store.recordFiles(ws, [{ path: 'de.docx' }])).toBe(false);
    const list = await store.list(ws);
    expect(list.map((a) => [a.source, a.path, a.title])).toEqual(
      expect.arrayContaining([['file', 'Tóm tắt/chuong-3.md', 'chuong-3.md'], ['file', 'de.docx', 'de.docx']]),
    );
    rmSync(path.join(ws, 'de.docx'));
    expect((await store.list(ws)).map((a) => a.path)).toEqual(['Tóm tắt/chuong-3.md']);
  });

  it('lấy lại file Claude từng tạo từ lịch sử phiên, chỉ một lần', async () => {
    const ws = path.join(dir, 'ws-cu');
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, 'tom-tat.md'), 'x');
    writeFileSync(path.join(ws, 'sua.md'), 'x');
    const messages = [
      { message: { content: [{ type: 'tool_use', id: 'a', name: 'Write', input: { file_path: path.join(ws, 'tom-tat.md') } }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'File created successfully at: …' }] } },
      // Ghi đè file có sẵn: không tính là sản phẩm mới.
      { message: { content: [{ type: 'tool_use', id: 'b', name: 'Write', input: { file_path: 'sua.md' } }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'The file has been updated successfully.' }] } },
      // Ngoài thư mục làm việc: bỏ qua.
      { message: { content: [{ type: 'tool_use', id: 'c', name: 'Write', input: { file_path: '/tmp/x.md' } }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'c', content: 'File created successfully' }] } },
    ];
    expect(createdFilesFromMessages(ws, messages)).toEqual(['tom-tat.md']);
    const store = new ArtifactStore(path.join(dir, 'kho-cu'));
    let scans = 0;
    const find = async () => (scans++, createdFilesFromMessages(ws, messages));
    expect(await store.backfill(ws, find)).toBe(true);
    expect(await store.backfill(ws, find)).toBe(false);
    expect(scans).toBe(1);
    expect((await store.list(ws)).map((a) => a.path)).toEqual(['tom-tat.md']);
  });
});
