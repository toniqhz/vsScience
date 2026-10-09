import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

// Trích nội dung chữ của file để so sánh phiên bản:
// Word theo đoạn văn, Excel theo ô ("Trang!A1: giá trị"), PowerPoint theo đoạn chữ của từng slide, CSV theo dòng.

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function unzip(data: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(data);
}

/** Đoạn chữ của từng slide trong file .pptx, theo thứ tự slide: "Slide 3: …". Ghi chú người thuyết trình ghi "(ghi chú)". */
export function pptxParagraphs(data: Uint8Array): string[] {
  const files = unzip(data);
  const slideNo = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
  const paragraphsOf = (xml: string) =>
    xml
      .split(/<\/a:p>/)
      .map((p) => [...p.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1] ?? '')).join(''))
      .filter((t) => t.trim());
  const out: string[] = [];
  const slides = Object.keys(files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => slideNo(a) - slideNo(b));
  for (const f of slides) {
    const n = slideNo(f);
    for (const t of paragraphsOf(strFromU8(files[f]!))) out.push(`Slide ${n}: ${t}`);
    const notes = files[`ppt/notesSlides/notesSlide${n}.xml`];
    if (notes) for (const t of paragraphsOf(strFromU8(notes))) out.push(`Slide ${n} (ghi chú): ${t}`);
  }
  return out;
}

/** Đoạn văn của file .docx (kể cả chữ trong công thức toán OMML). */
export function docxParagraphs(data: Uint8Array): string[] {
  const files = unzip(data);
  const doc = files['word/document.xml'];
  if (!doc) return [];
  const xml = strFromU8(doc);
  const paragraphs: string[] = [];
  for (const p of xml.split(/<\/w:p>/)) {
    let text = '';
    const re = /<(w|m):t(?:\s[^>]*)?>([^<]*)<\/\1:t>|<w:tab\/>|<w:br\/>/g;
    for (let m = re.exec(p); m; m = re.exec(p)) {
      if (m[0] === '<w:tab/>') text += '\t';
      else if (m[0] === '<w:br/>') text += ' ';
      else text += decodeXml(m[2] ?? '');
    }
    if (text.trim()) paragraphs.push(text);
  }
  return paragraphs;
}

/** Các ô có dữ liệu của file .xlsx, mỗi ô một dòng: "Trang!A1: giá trị (= công thức)". */
export function xlsxCells(data: Uint8Array): string[] {
  const files = unzip(data);
  const text = (name: string) => (files[name] ? strFromU8(files[name]!) : '');

  const shared: string[] = [];
  for (const si of text('xl/sharedStrings.xml').split(/<\/si>/)) {
    if (!si.includes('<si')) continue;
    let s = '';
    for (const m of si.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) s += decodeXml(m[1] ?? '');
    shared.push(s);
  }

  const rels = new Map<string, string>();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, ''));
  }

  const lines: string[] = [];
  for (const m of text('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(/name="([^"]*)"/.exec(m[0])?.[1] ?? '');
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    const target = rid ? rels.get(rid) : undefined;
    if (!target) continue;
    const sheet = text(path.posix.join('xl', target));
    for (const c of sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? '';
      const body = c[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      const formula = /<f(?:\s[^>]*)?>([^<]*)<\/f>/.exec(body)?.[1];
      let value = /<v>([^<]*)<\/v>/.exec(body)?.[1];
      if (type === 's' && value !== undefined) value = shared[Number(value)] ?? '';
      else if (type === 'inlineStr') value = [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((x) => x[1]).join('');
      else if (type === 'b' && value !== undefined) value = value === '1' ? 'TRUE' : 'FALSE';
      if ((value === undefined || value === '') && !formula) continue;
      lines.push(`${name}!${ref}: ${decodeXml(value ?? '')}${formula ? `   (= ${decodeXml(formula)})` : ''}`);
    }
  }
  return lines;
}

/**
 * Nội dung dạng dòng để so sánh, hoặc null nếu không trích được (PDF, file hỏng…).
 */
export function comparableLines(file: string, data: Uint8Array | null): string[] | null {
  if (!data) return [];
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === '.docx') return docxParagraphs(data);
    if (ext === '.xlsx' || ext === '.xlsm') return xlsxCells(data);
    if (ext === '.pptx') return pptxParagraphs(data);
    if (ext === '.csv' || ext === '.md' || ext === '.markdown' || ext === '.txt' || ext === '.html' || ext === '.htm')
      return new TextDecoder().decode(data).split(/\r?\n/);
  } catch {
    return null;
  }
  return null;
}
