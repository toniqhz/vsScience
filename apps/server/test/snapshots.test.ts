import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Snapshots } from '../src/snapshots.js';

function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('');
  return zipSync({
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  });
}

function xlsx(rows: { ref: string; text?: string; formula?: string; value?: string }[]): Uint8Array {
  const strings = rows.filter((r) => r.text !== undefined).map((r) => r.text!);
  const cells = rows
    .map((r) =>
      r.text !== undefined
        ? `<c r="${r.ref}" t="s"><v>${strings.indexOf(r.text)}</v></c>`
        : `<c r="${r.ref}"><f>${r.formula}</f><v>${r.value}</v></c>`,
    )
    .join('');
  return zipSync({
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Điểm" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8(`<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData><row>${cells}</row></sheetData></worksheet>`),
  });
}

let base: string;
let root: string;
let snaps: Snapshots;
const original = docx(['Đề kiểm tra', 'Câu 1: A', 'Câu 2 cũ', 'Câu 3: C']);

beforeAll(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'snap-test-')));
  root = path.join(base, 'ws');
  mkdirSync(path.join(root, 'Đề thi'), { recursive: true });
  mkdirSync(path.join(root, '.an'));
  writeFileSync(path.join(root, 'Đề thi', 'de.docx'), original);
  writeFileSync(path.join(root, 'sach.pdf'), '%PDF-1.4 cũ');
  writeFileSync(path.join(root, '.an', 'x.docx'), 'ẩn');
  writeFileSync(path.join(root, 'ghi-chu.txt'), 'không theo dõi');
  snaps = new Snapshots(path.join(base, 'kho'));
  await snaps.open(root);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('bản lưu', () => {
  it('lần đầu lưu "Bản đầu tiên", không tạo .git trong thư mục làm việc', async () => {
    const s = await snaps.status();
    expect(s.files).toEqual([]);
    expect(s.snapshots.map((x) => x.message)).toEqual(['Bản đầu tiên']);
    expect(existsSync(path.join(root, '.git'))).toBe(false);
  });

  it('nhận ra file sửa, mới, xóa; bỏ qua file ẩn và file không theo dõi', async () => {
    writeFileSync(path.join(root, 'Đề thi', 'de.docx'), docx(['Đề kiểm tra', 'Câu 1: A', 'Câu 2 mới', 'Câu 3: C', 'Câu 4: D']));
    writeFileSync(path.join(root, 'diem.xlsx'), xlsx([{ ref: 'A1', text: 'Tổng' }, { ref: 'B1', formula: 'SUM(B2:B3)', value: '17' }]));
    unlinkSync(path.join(root, 'sach.pdf'));
    writeFileSync(path.join(root, '.an', 'x.docx'), 'ẩn 2');
    writeFileSync(path.join(root, 'ghi-chu.txt'), 'đổi');
    expect((await snaps.status()).files).toEqual([
      // Sắp theo tiếng Việt: "Đề" đứng sau "D", trước "s".
      { path: 'diem.xlsx', status: 'added' },
      { path: 'Đề thi/de.docx', status: 'modified' },
      { path: 'sach.pdf', status: 'deleted' },
    ]);
  });

  it('diff Word theo đoạn văn', async () => {
    const d = await snaps.diff('Đề thi/de.docx');
    expect(d.note).toBe('So sánh theo đoạn.');
    expect(d.change).toMatchObject({ additions: 2, deletions: 1 });
    expect(d.change!.hunks[0]).toEqual({
      oldStart: 1,
      newStart: 1,
      lines: [' Đề kiểm tra', ' Câu 1: A', '-Câu 2 cũ', '+Câu 2 mới', ' Câu 3: C', '+Câu 4: D'],
    });
  });

  it('diff Excel theo ô (kèm công thức); PDF chỉ có ghi chú', async () => {
    const x = await snaps.diff('diem.xlsx');
    expect(x.change?.kind).toBe('create');
    expect(x.change!.hunks[0]!.lines).toEqual(['+Điểm!A1: Tổng', '+Điểm!B1: 17   (= SUM(B2:B3))']);
    const p = await snaps.diff('sach.pdf');
    expect(p.change).toBeNull();
    expect(p.note).toContain('PDF');
  });

  it('hoàn tác từng file về bản lưu gần nhất', async () => {
    await snaps.restore('Đề thi/de.docx');
    expect(new Uint8Array(readFileSync(path.join(root, 'Đề thi', 'de.docx')))).toEqual(original);
    await snaps.restore('diem.xlsx');
    expect(existsSync(path.join(root, 'diem.xlsx'))).toBe(false);
    await snaps.restore('sach.pdf');
    expect(readFileSync(path.join(root, 'sach.pdf'), 'utf8')).toBe('%PDF-1.4 cũ');
    expect((await snaps.status()).files).toEqual([]);
    await expect(snaps.restore('Đề thi/de.docx')).rejects.toThrow('không có thay đổi');
    expect(await snaps.diff('Đề thi/de.docx')).toMatchObject({ status: null, change: null });
  });

  it('lưu bản: có thay đổi thì tạo bản mới, không có thì bỏ qua', async () => {
    writeFileSync(path.join(root, 'moi.docx'), docx(['Mới']));
    expect(await snaps.snapshot('Thêm đề mới')).toBe(true);
    expect(await snaps.snapshot('Không đổi')).toBe(false);
    const s = await snaps.status();
    expect(s.files).toEqual([]);
    expect(s.snapshots.map((x) => x.message)).toEqual(['Thêm đề mới', 'Bản đầu tiên']);
  });
});
