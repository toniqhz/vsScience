import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { ContentSearch, findAll, fold, textUnits, type SearchFile } from '../src/search.js';

const slide = (...paras: string[]) =>
  strToU8(`<p:sld><p:cSld><p:spTree>${paras.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`);

describe('so khớp không dấu', () => {
  it('tìm không cần gõ dấu, vị trí khớp đúng trên chuỗi gốc (cả chuỗi NFD của macOS)', () => {
    const { text, hits } = findAll('Phân tích PHÂN TỬ, phan tu', fold('phân tử'));
    expect(hits.map(([a, b]) => text.slice(a, b))).toEqual(['PHÂN TỬ', 'phan tu']);
    const nfd = 'Kỹ thuật chuẩn đoán'.normalize('NFD');
    const r = findAll(nfd, fold('chuan doan'));
    expect(r.hits.map(([a, b]) => r.text.slice(a, b))).toEqual(['chuẩn đoán']);
  });
});

describe('đơn vị chữ theo loại file', () => {
  it('PowerPoint: theo slide; ghi chú không hiện trong khung xem', () => {
    const data = zipSync({ 'ppt/slides/slide1.xml': slide('PCR'), 'ppt/notesSlides/notesSlide1.xml': slide('nhắc PCR') });
    expect(textUnits({ rel: 'a.pptx', kind: 'powerpoint' }, data)).toEqual([
      { loc: 'Slide 1', text: 'PCR', target: {} },
      { loc: 'Slide 1 · ghi chú', text: 'nhắc PCR', target: {}, hidden: true },
    ]);
  });

  it('file chữ theo dòng; .doc/.ppt đời cũ không đọc', () => {
    expect(textUnits({ rel: 'a.md', kind: 'markdown' }, strToU8('# A\nb'))).toEqual([
      { loc: 'Dòng 1', text: '# A', target: { row: 0 } },
      { loc: 'Dòng 2', text: 'b', target: { row: 1 } },
    ]);
    expect(textUnits({ rel: 'a.doc', kind: 'word' }, strToU8('x'))).toBeNull();
  });
});

describe('ContentSearch', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tim-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (rel: string, kind: SearchFile['kind'], content: string | Uint8Array): SearchFile => {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return { rel, abs, kind, size: typeof content === 'string' ? Buffer.byteLength(content) : content.length, mtime: 1 };
  };

  it('PDF theo trang, PowerPoint bỏ ghi chú khỏi thứ tự lần khớp, đọc PDF một lần rồi nhớ', async () => {
    const files = [
      file('Bài giảng/PCR.pptx', 'powerpoint', zipSync({ 'ppt/slides/slide1.xml': slide('Kỹ thuật PCR'), 'ppt/notesSlides/notesSlide1.xml': slide('pcr'), 'ppt/slides/slide2.xml': slide('real-time PCR') })),
      file('sach.pdf', 'pdf', 'pdf'),
      file('ghi chu.md', 'markdown', 'không có gì'),
      file('anh.png', 'image', 'x'),
    ];
    let pdfCalls = 0;
    const search = new ContentSearch(async (paths) => {
      pdfCalls++;
      return new Map(paths.map((p) => [p, ['Trang đầu', 'Phản ứng PCR và pcr lồng']]));
    });
    const r = await search.search(files, 'pcr');
    expect(r.scanned).toBe(3);
    expect(r.files.map((f) => [f.path, f.total])).toEqual([
      ['Bài giảng/PCR.pptx', 3],
      ['sach.pdf', 2],
    ]);
    expect(r.files[0]!.matches.map((m) => [m.loc, m.target])).toEqual([
      ['Slide 1', { occurrence: 0 }],
      ['Slide 1 · ghi chú', {}],
      ['Slide 2', { occurrence: 1 }],
    ]);
    const pdf = r.files[1]!.matches[0]!;
    expect(pdf).toMatchObject({ loc: 'Trang 2', target: { page: 2, inPage: 0, occurrence: 0 } });
    expect(r.files[1]!.matches[1]!.target).toEqual({ page: 2, inPage: 1, occurrence: 1 });
    expect(pdf.snippet.slice(pdf.start, pdf.end)).toBe('PCR');
    await search.search(files, 'phản ứng');
    expect(pdfCalls).toBe(1);
  });

  it('thiếu Python đọc PDF: vẫn tìm file khác và báo pdfUnavailable', async () => {
    const files = [file('b.pdf', 'pdf', 'pdf'), file('c.txt', 'text', 'tìm thấy')];
    const r = await new ContentSearch(async () => Promise.reject(new Error('no python'))).search(files, 'tim thay');
    expect(r.files.map((f) => f.path)).toEqual(['c.txt']);
    expect(r.pdfUnavailable).toBe(true);
  });
});
