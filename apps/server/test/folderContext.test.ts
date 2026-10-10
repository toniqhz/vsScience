import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EMPTY_CONTEXT, readFolderContext, writeFolderContext } from '../src/folderContext.js';

describe('bối cảnh thư mục trong CLAUDE.md', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'boi-canh-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const md = () => readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');

  it('tạo, đọc lại, sửa mà giữ phần người dùng tự viết, xóa khi để trống', async () => {
    expect(await readFolderContext(dir)).toEqual(EMPTY_CONTEXT);
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# Ghi chú riêng\n\nĐừng xóa dòng này.\n');
    const ctx = { ...EMPTY_CONTEXT, topic: 'Sinh học phân tử', citationStyle: 'Vancouver', notes: 'Dòng 1\nDòng 2 -- có gạch' };
    await writeFolderContext(dir, ctx);
    expect(md()).toContain('- Chủ đề / môn học: Sinh học phân tử');
    expect(md()).toContain('- Chuẩn trích dẫn: Vancouver');
    expect(md()).toContain('Đừng xóa dòng này.');
    // Trong chú thích HTML không được có "--" (ghi chú người dùng có "--" được mã hóa lại).
    const comment = /<!-- vsscience:boi-canh ([\s\S]*?) -->/.exec(md())![1]!;
    expect(comment).not.toContain('--');
    expect(await readFolderContext(dir)).toEqual(ctx);
    await writeFolderContext(dir, { ...ctx, topic: 'Hóa sinh' });
    expect(md().match(/Chủ đề/g)).toHaveLength(1);
    expect((await readFolderContext(dir)).topic).toBe('Hóa sinh');
    await writeFolderContext(dir, EMPTY_CONTEXT);
    expect(md()).toBe('# Ghi chú riêng\n\nĐừng xóa dòng này.\n');
  });
});
