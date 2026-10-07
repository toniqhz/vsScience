import { readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Kiểm tra một thao tác của Claude có đụng tới file ngoài thư mục được phép không
 * (thư mục làm việc + thư mục nháp của app). Dùng ở chế độ "Tự động": trong phạm vi thì
 * cho chạy luôn, ngoài phạm vi thì hỏi người dùng kèm lý do.
 *
 * Đây là kiểm tra theo nội dung câu lệnh, không phải sandbox của hệ điều hành: nó bắt được
 * đường dẫn viết trong lệnh, trong đoạn script kèm theo (heredoc) và trong file script chạy
 * từ thư mục được phép, nhưng không thấy đường dẫn được ghép lúc chạy (biến môi trường lạ, v.v.).
 */

/** Thư mục hệ thống chứa chương trình và thư viện: dùng để chạy lệnh, không phải tài liệu của người dùng. */
const SYSTEM_PREFIXES = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/opt', '/snap', '/nix'];
const SYSTEM_FILES = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/zero', '/dev/urandom']);

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Glob', 'Grep', 'LS']);
const SCRIPT_EXT = /\.(py|sh|bash|js|mjs|cjs|ts|r|R|pl|rb)$/;
const MAX_SCRIPT_BYTES = 256 * 1024;

const home = homedir();

function isInside(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Tách câu lệnh shell thành các "từ", giữ nguyên chuỗi trong nháy ('…' hoặc "…") và
 * dấu cách đã escape — để đường dẫn có dấu cách như ".../cham thi/a.docx" không bị cắt đôi.
 */
export function shellWords(src: string): string[] {
  const words: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) words.push(cur);
    cur = '';
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      flush();
      const end = src.indexOf(ch, i + 1);
      const inner = end < 0 ? src.slice(i + 1) : src.slice(i + 1, end);
      if (inner) words.push(inner);
      // Chuỗi trong nháy có thể chứa code (python -c "…"): tách tiếp phần bên trong — trừ khi
      // nó là một đường dẫn duy nhất (có thể chứa dấu cách, như ".../cham thi/a.docx").
      const singlePath = /^(?:\/|~|\$HOME|\$\{HOME\}|\.\.\/)/.test(inner) && !/[\n;()'"`]/.test(inner);
      if (!singlePath && /[\s;(),]/.test(inner)) words.push(...shellWords(inner));
      i = end < 0 ? src.length : end;
    } else if (ch === '\\' && src[i + 1] === ' ') {
      cur += ' ';
      i++;
    } else if (/[\s;|&<>(){}[\],=]/.test(ch)) {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  return words;
}

/** Biến một "từ" thành đường dẫn tuyệt đối nếu nó trông như đường dẫn đáng kiểm tra; ngược lại trả về null. */
function toPath(word: string, cwd: string): string | null {
  let w = word.trim();
  if (!w || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return null; // URL
  w = w.replace(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/, home).replace(/^~(?=\/|$)/, home);
  // Chỉ lấy phần trước ký tự đại diện: /a/b/*.docx → /a/b
  const glob = w.search(/[*?]/);
  if (glob >= 0) w = w.slice(0, glob);
  if (path.isAbsolute(w)) {
    if (w === '/' || w.startsWith('//')) return null; // phép chia, chú thích, URL không giao thức
    return path.resolve(w); // chuẩn hóa, bỏ "/" ở cuối
  }
  // Đường dẫn tương đối chỉ ra ngoài được khi có "..".
  if (/(^|\/)\.\.(\/|$)/.test(w)) return path.resolve(cwd, w);
  return null;
}

export class FolderGuard {
  constructor(
    /** Thư mục làm việc và thư mục nháp — Claude được tự do trong đó. */
    private readonly roots: () => string[],
  ) {}

  #allowed(p: string): boolean {
    if (SYSTEM_FILES.has(p) || p.startsWith('/proc/self/')) return true;
    if (SYSTEM_PREFIXES.some((s) => isInside(p, s))) return true;
    return this.roots().some((r) => isInside(p, r));
  }

  /** Đường dẫn ngoài phạm vi trong một đoạn lệnh/script (kèm quét một tầng file script được gọi). */
  #scan(text: string, cwd: string, out: Set<string>, depth: number) {
    for (const word of shellWords(text)) {
      const p = toPath(word, cwd) ?? (depth === 0 && SCRIPT_EXT.test(word) ? path.resolve(cwd, word) : null);
      if (!p) continue;
      if (!this.#allowed(p)) {
        out.add(p);
        continue;
      }
      // Script nằm trong phạm vi: đọc nội dung để xem nó có đụng tới file bên ngoài không.
      if (depth === 0 && SCRIPT_EXT.test(p) && !SYSTEM_PREFIXES.some((s) => isInside(p, s))) {
        try {
          if (statSync(p).size <= MAX_SCRIPT_BYTES) this.#scan(readFileSync(p, 'utf8'), path.dirname(p), out, 1);
        } catch {
          // Script chưa tồn tại hoặc không đọc được — bỏ qua.
        }
      }
    }
  }

  /** Danh sách đường dẫn ngoài phạm vi mà công cụ này sẽ đụng tới (rỗng nghĩa là an toàn để tự cho phép). */
  outside(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
    const out = new Set<string>();
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    if (FILE_TOOLS.has(toolName)) {
      const p = str(input.file_path) || str(input.notebook_path);
      if (p) {
        const abs = path.resolve(cwd, p);
        if (!this.#allowed(abs)) out.add(abs);
      }
    } else if (SEARCH_TOOLS.has(toolName)) {
      const p = str(input.path);
      if (p && !this.#allowed(path.resolve(cwd, p))) out.add(path.resolve(cwd, p));
      const pattern = str(input.pattern);
      if (path.isAbsolute(pattern)) {
        const base = toPath(pattern, cwd);
        if (base && !this.#allowed(base)) out.add(base);
      }
    } else if (toolName === 'Bash') {
      this.#scan(str(input.command), cwd, out, 0);
    }
    return [...out];
  }

  /** Công cụ này có thể đụng tới file trên máy hay không (để quyết định có cần kiểm tra). */
  static touchesFiles(toolName: string): boolean {
    return FILE_TOOLS.has(toolName) || SEARCH_TOOLS.has(toolName) || toolName === 'Bash';
  }
}

/**
 * Thư mục chứa scratchpad mà Claude Code cấp cho mỗi phiên của một thư mục làm việc:
 * <tmp>/claude-<uid>/<đường dẫn thư mục, ký tự không phải chữ/số thay bằng "-">/<phiên>/scratchpad
 */
export function claudeScratchRoot(cwd: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const base = process.env.CLAUDE_CODE_TMPDIR || tmpdir();
  return path.join(base, `claude-${uid}`, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Rút gọn đường dẫn để hiện cho người dùng: thay thư mục nhà bằng ~. */
export function displayOutside(p: string): string {
  return isInside(p, home) ? `~${p.slice(home.length)}` : p;
}
