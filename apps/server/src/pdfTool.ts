import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Công cụ đọc PDF đi kèm app (tools/pdf.py, chạy bằng Python portable có PyMuPDF).
 * Công cụ Read của Claude Code cần pdftoppm (poppler) để đọc PDF theo trang; máy người dùng
 * thường không có, nên Claude dùng công cụ này thay thế.
 */
function toolsDir(): string {
  return process.env.IDE_TOOLS_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools');
}

export function pdfToolPath(): string {
  return path.join(toolsDir(), 'pdf.py');
}

/** Công cụ đọc PowerPoint (.pptx) đi kèm app (tools/slides.py, chạy bằng python-pptx). Cùng cách gọi với công cụ PDF. */
export function slidesToolPath(): string {
  return path.join(toolsDir(), 'slides.py');
}

/** Công cụ tài liệu đi kèm app: nhận xét Word, tài liệu tham khảo, xuất Word. */
export function docToolPaths() {
  const dir = toolsDir();
  return {
    comments: path.join(dir, 'docx_comments.py'),
    cite: path.join(dir, 'cite.py'),
    md2docx: path.join(dir, 'md2docx.py'),
  };
}

/** Hướng dẫn cho system prompt: nhận xét vào lề Word, thư viện tài liệu tham khảo, xuất bài viết ra Word. */
export function docToolsPrompt(paths = docToolPaths()): string {
  const py = (p: string) => `python "${p}"`;
  return `# Nhận xét Word, tài liệu tham khảo, xuất Word
- Nhận xét (comment) bên lề file Word, như người phản biện/giáo viên: ghi danh sách nhận xét vào file JSON trong thư mục nháp, dạng \`[{"quote": "đoạn chữ ngắn có thật trong file", "comment": "nhận xét cụ thể + đề xuất sửa"}]\`, rồi chạy \`${py(paths.comments)} add "<file.docx>" --spec "<nháp>/nhan-xet.json"\`. Mặc định ghi ra bản sao "<tên> - nhận xét.docx", file gốc giữ nguyên (chỉ dùng --in-place khi người dùng muốn ghi vào file gốc). "quote" chép đúng vài từ tới một câu nằm trong MỘT đoạn văn; lệnh báo những quote không tìm thấy để sửa và chạy lại cho các mục đó. Xem nhận xét đang có: \`${py(paths.comments)} list "<file.docx>"\`. App mở bản sao ở khung bên phải để người dùng xem nhận xét.
- Thư viện tài liệu tham khảo của thư mục: dùng file .bib/.ris người dùng đã có (ví dụ xuất từ Zotero); chưa có thì tạo \`tai-lieu-tham-khao.bib\` (BibTeX) ở thư mục làm việc. Mỗi nguồn bên ngoài đã tra được thì thêm một mục (khóa dạng tacgiaNam, đủ author, title, year, journal/publisher, doi nếu có; tài liệu tiếng Việt thêm language = {vietnamese}). Trong bài viết Markdown trích dẫn bằng \`[@khoa]\`, \`[@khoa1; @khoa2, tr. 12]\`.
  \`${py(paths.cite)} list|check "<thư viện>"\` xem/kiểm tra mục thiếu thông tin; \`${py(paths.cite)} format "<thư viện>" --style apa|vancouver [--keys k1,k2]\` in danh mục đã định dạng.
- Xuất bài viết Markdown ra Word kèm trích dẫn và danh mục tài liệu tham khảo: \`${py(paths.md2docx)} "<bai.md>" --bib "<thư viện>" --style apa|vancouver [--out "<bai.docx>"]\`. Chuẩn trích dẫn theo bối cảnh thư mục; không có thì APA.`;
}

/** Trích chữ nhiều PDF một lượt cho ô tìm kiếm nội dung (tools/pdftext.py), không dành cho Claude. */
export function pdfTextToolPath(): string {
  return path.join(toolsDir(), 'pdftext.py');
}

export type PdfToolSub = 'info' | 'text' | 'search' | 'render' | 'ocr-set';

export interface PdfToolCall {
  sub: PdfToolSub;
  file: string;
  pages?: string;
  query?: string;
  out?: string;
  /** ocr-set: file chữ đã nhận dạng từ ảnh trang quét. */
  textFile?: string;
}

const SUBS = new Set<PdfToolSub>(['info', 'text', 'search', 'render', 'ocr-set']);
const PYTHON = /^(?:.*[\\/])?python(?:3(?:\.\d+)?)?(?:\.exe)?$/i;

/** Tách từ theo nháy đơn/kép; trả null nếu có ký tự điều khiển shell ngoài nháy (nối lệnh, chuyển hướng…). */
function words(command: string, powershell: boolean): string[] | null {
  const out: string[] = [];
  let cur = '';
  let has = false;
  const src = command.trim();
  if (/[\r\n]/.test(src)) return null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) return null;
      const inner = src.slice(i + 1, end);
      // Trong nháy kép, shell vẫn thay biến/lệnh con: không chấp nhận.
      if (ch === '"' && /[$`]/.test(inner)) return null;
      cur += inner;
      has = true;
      i = end;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else if (ch === '\\' && !powershell) {
      // posix: dấu \ ngoài nháy là ký tự thoát.
      return null;
    } else if (/[;|&<>$`(){}\n]/.test(ch)) {
      // PowerShell: cho phép toán tử gọi "& " ở đầu lệnh.
      if (powershell && ch === '&' && out.length === 0 && !has) continue;
      return null;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/');
  return /^[a-z]:/i.test(b) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/**
 * Nhận ra lệnh gọi đúng công cụ PDF của app, dạng
 *   python "<pdf.py>" text "<file>" --pages 3-7
 * Chỉ một lệnh đơn, không nối lệnh hay chuyển hướng. Công cụ chỉ đọc PDF (render ghi ảnh vào --out),
 * nên app tự cho phép khi các đường dẫn nằm trong phạm vi được phép.
 */
export function parsePdfToolCommand(command: string, toolPath: string, shell: 'posix' | 'powershell'): PdfToolCall | null {
  const w = words(command, shell === 'powershell');
  if (!w || w.length < 4) return null;
  const [py, script, sub, file, ...rest] = w as [string, string, string, string, ...string[]];
  if (!PYTHON.test(py) || !samePath(script, toolPath) || !SUBS.has(sub as PdfToolSub)) return null;
  const call: PdfToolCall = { sub: sub as PdfToolSub, file };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const v = rest[i + 1];
    if ((a === '--pages' || a === '--out' || a === '--dpi' || a === '--text-file') && v !== undefined) {
      if (a === '--pages') call.pages = v;
      else if (a === '--out') call.out = v;
      else if (a === '--text-file') call.textFile = v;
      i++;
    } else if (call.sub === 'search' && call.query === undefined && !a.startsWith('--')) {
      call.query = a;
    } else {
      return null;
    }
  }
  return call;
}

/** Hướng dẫn cho system prompt: đọc PowerPoint bằng công cụ đi kèm. */
export function slidesToolPrompt(toolPath: string): string {
  const tool = `python "${toolPath}"`;
  return `# Đọc PowerPoint
Công cụ Read không đọc được PowerPoint. Đọc .pptx bằng công cụ của app (cùng cách gọi như công cụ PDF, mỗi lần một lệnh đơn):
- \`${tool} info "<file.pptx>"\`: số slide và tiêu đề từng slide.
- \`${tool} text "<file.pptx>" --pages 1-10\`: chữ, bảng, ghi chú người thuyết trình của từng slide, có dòng "=== Slide N ===" để trích dẫn số slide.
- \`${tool} search "<file.pptx>" "<từ khóa>"\`: các slide có từ khóa.
Các lệnh này chỉ đọc file, app tự cho chạy không cần hỏi. Tạo hay sửa slide thì viết script dùng python-pptx. File .ppt đời cũ: nhờ người dùng mở bằng PowerPoint và lưu lại thành .pptx.`;
}

/** Hướng dẫn cho system prompt. */
export function pdfToolPrompt(toolPath: string, platform = process.platform): string {
  const q = (s: string) => `"${s}"`;
  const tool = `python ${q(toolPath)}`;
  return `# Đọc PDF
Máy không có pdftoppm nên công cụ Read không đọc được PDF theo trang. Đọc PDF bằng công cụ của app (chạy trong ${platform === 'win32' ? 'PowerShell' : 'shell'}, đặt đường dẫn trong nháy, mỗi lần một lệnh đơn):
- \`${tool} info "<file.pdf>"\`: số trang, mục lục (bookmark), trang nào là ảnh quét. Chạy trước khi đọc sách hay tài liệu dài.
- \`${tool} text "<file.pdf>" --pages 1-20\`: chữ từng trang, có dòng "=== Trang N ===" để trích dẫn số trang. Sách dài thì đọc dần theo chương, khoảng 20–30 trang mỗi lần.
- \`${tool} search "<file.pdf>" "<từ khóa>"\`: tìm các trang có từ khóa.
- \`${tool} render "<file.pdf>" --pages 5 --out "<thư mục nháp>"\`: chụp trang thành ảnh PNG rồi xem bằng Read. Dùng khi cần xem hình, bảng, công thức hoặc trang ảnh quét.
- \`${tool} ocr-set "<file.pdf>" --pages 5 --text-file "<thư mục nháp>/trang-5.txt"\`: sau khi đọc chữ từ ảnh một trang quét, ghi chép nguyên văn chữ của trang (UTF-8, giữ xuống dòng, đúng dấu tiếng Việt) vào file nháp rồi lưu bằng lệnh này. Lần sau text/search và ô tìm kiếm của app đọc được trang đó mà không phải chụp lại. Người dùng nhờ "nhận dạng chữ"/OCR một file quét thì làm lần lượt: info → với mỗi trang quét (tối đa 10 trang mỗi lượt render): render → đọc ảnh → chép chữ → ocr-set; báo tiến độ và hỏi trước khi làm file rất dài (nhiều chục trang) vì tốn lượt dùng.
Các lệnh này chỉ đọc PDF (ocr-set chỉ ghi file chữ ẩn cạnh PDF), app tự cho chạy không cần hỏi.`;
}
