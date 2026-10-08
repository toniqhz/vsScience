import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Công cụ đọc PDF đi kèm app (tools/pdf.py, chạy bằng Python portable có PyMuPDF).
 * Công cụ Read của Claude Code cần pdftoppm (poppler) để đọc PDF theo trang; máy người dùng
 * thường không có, nên Claude dùng công cụ này thay thế.
 */
export function pdfToolPath(): string {
  if (process.env.IDE_TOOLS_DIR) return path.join(process.env.IDE_TOOLS_DIR, 'pdf.py');
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/pdf.py');
}

export type PdfToolSub = 'info' | 'text' | 'search' | 'render';

export interface PdfToolCall {
  sub: PdfToolSub;
  file: string;
  pages?: string;
  query?: string;
  out?: string;
}

const SUBS = new Set<PdfToolSub>(['info', 'text', 'search', 'render']);
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
    if ((a === '--pages' || a === '--out' || a === '--dpi') && v !== undefined) {
      if (a === '--pages') call.pages = v;
      else if (a === '--out') call.out = v;
      i++;
    } else if (call.sub === 'search' && call.query === undefined && !a.startsWith('--')) {
      call.query = a;
    } else {
      return null;
    }
  }
  return call;
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
Các lệnh này chỉ đọc file, app tự cho chạy không cần hỏi.`;
}
