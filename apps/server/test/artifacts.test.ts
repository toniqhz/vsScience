import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ArtifactStore, artifactTitle, artifactUrl, artifactsFromMessages } from '../src/artifacts.js';

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
    expect(artifactsFromMessages(ws, messages).files).toEqual(['tom-tat.md']);
    const store = new ArtifactStore(path.join(dir, 'kho-cu'));
    let scans = 0;
    const find = async () => (scans++, artifactsFromMessages(ws, messages));
    expect(await store.backfill(ws, find)).toBe(true);
    expect(await store.backfill(ws, find)).toBe(false);
    expect(scans).toBe(1);
    expect((await store.list(ws)).map((a) => a.path)).toEqual(['tom-tat.md']);
  });

  it('link tài liệu Claude Docs trong kết quả công cụ: ghi nhận một lần, có tiêu đề', async () => {
    const url = 'https://claude.ai/code/artifact/da850ef8-5abb-4fa1-bba2-d02fe2bbe461';
    const messages = [
      { message: { content: [{ type: 'tool_use', id: 'd', name: 'mcp__claude_ai_Claude_Docs__batch', input: { container: { kind: 'project', create: { name: 'Tóm tắt trang 20–25' } } } }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'd', content: [{ type: 'text', text: `{"verdict":"allow","link":"${url}"}` }] }] } },
      { message: { content: [{ type: 'tool_use', id: 'e', name: 'mcp__claude_ai_Claude_Docs__update', input: {} }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'e', content: `ok ${url}` }] } },
    ];
    const { links } = artifactsFromMessages('/ws', messages);
    expect(links).toEqual([{ url, title: 'Tóm tắt trang 20–25', doc: true }]);
    const store = new ArtifactStore(path.join(dir, 'kho-doc'));
    expect(await store.recordLinks('/ws/doc', links)).toBe(true);
    expect(await store.recordLinks('/ws/doc', [{ url, title: null, doc: true }])).toBe(false);
    expect(await store.list('/ws/doc')).toMatchObject([{ source: 'published', kind: 'doc', local: false, title: 'Tóm tắt trang 20–25', url }]);
  });

  it('liệt kê mọi file trong thư mục artifact/ của thư mục làm việc, không trùng với mục đã ghi nhận', async () => {
    const ws = path.join(dir, 'ws-folder');
    mkdirSync(path.join(ws, 'artifact', 'Chương 3'), { recursive: true });
    writeFileSync(path.join(ws, 'artifact', 'Tóm tắt.md'), '# x');
    writeFileSync(path.join(ws, 'artifact', 'Chương 3', 'bieu-do.html'), '<p>x</p>');
    writeFileSync(path.join(ws, 'artifact', '.an.md'), 'ẩn');
    const store = new ArtifactStore(path.join(dir, 'kho-folder'));
    await store.recordFiles(ws, [{ path: 'artifact/Tóm tắt.md' }]);
    const list = await store.list(ws);
    expect(list.map((a) => a.path).sort()).toEqual(['artifact/Chương 3/bieu-do.html', 'artifact/Tóm tắt.md']);
    expect(list.every((a) => a.source === 'file')).toBe(true);
  });
});
