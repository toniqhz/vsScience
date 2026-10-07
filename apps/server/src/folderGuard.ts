import { readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Kiểm tra một thao tác của Claude có đụng tới file ngoài thư mục được phép không
 * (thư mục làm việc + scratchpad của Claude Code + công cụ đi kèm app). Dùng ở chế độ "Tự động":
 * trong phạm vi thì cho chạy luôn, ngoài phạm vi thì hỏi người dùng kèm lý do.
 *
 * Đây là kiểm tra theo nội dung câu lệnh, không phải sandbox của hệ điều hành: nó bắt được
 * đường dẫn viết trong lệnh (Bash hoặc PowerShell), trong đoạn script kèm theo và trong file script
 * chạy từ thư mục được phép, nhưng không thấy đường dẫn được ghép lúc chạy.
 */

/** Thư mục hệ thống chứa chương trình và thư viện (Linux/macOS): để chạy lệnh, không phải tài liệu. */
const POSIX_SYSTEM_PREFIXES = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/opt', '/snap', '/nix', '/System', '/Library'];
const POSIX_SYSTEM_FILES = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/zero', '/dev/urandom']);
/** Biến môi trường trỏ tới thư mục chương trình của Windows. */
const WINDOWS_SYSTEM_VARS = ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles'];

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Glob', 'Grep', 'LS']);
const SHELL_TOOLS: Record<string, ShellMode> = { Bash: 'posix', PowerShell: 'powershell' };
const SCRIPT_EXT = /\.(py|sh|bash|ps1|bat|cmd|js|mjs|cjs|ts|r|R|pl|rb)$/;
const MAX_SCRIPT_BYTES = 256 * 1024;

export type ShellMode = 'posix' | 'powershell';

export interface GuardOptions {
  /** Thư mục công cụ đi kèm app (Python, Claude CLI): được dùng tự do. */
  extraAllowed?: string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Đường dẫn trông như một đường dẫn duy nhất (có thể chứa dấu cách) thay vì một đoạn code. */
const SINGLE_PATH = /^(?:\/|~|\$HOME\b|\$\{HOME\}|\$env:|\$\{env:|%[A-Za-z_]|\.\.[\\/]|[A-Za-z]:[\\/]|\\\\)/;

/**
 * Tách câu lệnh thành các "từ", giữ nguyên chuỗi trong nháy và dấu cách đã escape — để đường dẫn
 * có dấu cách như ".../cham thi/a.docx" không bị cắt đôi.
 * posix: nháy ' " `, "\ " là dấu cách. PowerShell: nháy ' ", dấu ` là ký tự thoát.
 */
export function shellWords(src: string, mode: ShellMode = 'posix'): string[] {
  const words: string[] = [];
  const quotes = mode === 'powershell' ? `'"` : `'"\``;
  let cur = '';
  const flush = () => {
    if (cur) words.push(cur);
    cur = '';
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quotes.includes(ch)) {
      flush();
      const end = src.indexOf(ch, i + 1);
      const inner = end < 0 ? src.slice(i + 1) : src.slice(i + 1, end);
      if (inner) words.push(inner);
      // Chuỗi trong nháy có thể chứa code (python -c "…"): tách tiếp phần bên trong — trừ khi
      // nó là một đường dẫn duy nhất.
      const singlePath = SINGLE_PATH.test(inner) && !/[\n;()'"`]/.test(inner);
      if (!singlePath && /[\s;(),]/.test(inner)) words.push(...shellWords(inner, mode));
      i = end < 0 ? src.length : end;
    } else if (mode === 'powershell' && ch === '`') {
      cur += src[i + 1] ?? '';
      i++;
    } else if (mode === 'posix' && ch === '\\' && src[i + 1] === ' ') {
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

export class FolderGuard {
  readonly #p: typeof path.posix;
  readonly #win: boolean;
  readonly #env: NodeJS.ProcessEnv;
  readonly #home: string;
  readonly #system: string[];

  constructor(
    /** Thư mục làm việc và scratchpad. Mục kết thúc bằng "*" là tiền tố (tên thư mục bị cắt ngắn). */
    private readonly roots: () => string[],
    private readonly opts: GuardOptions = {},
  ) {
    this.#win = (opts.platform ?? process.platform) === 'win32';
    this.#p = this.#win ? path.win32 : path.posix;
    this.#env = opts.env ?? process.env;
    this.#home = opts.home ?? homedir();
    this.#system = this.#win
      ? WINDOWS_SYSTEM_VARS.map((v) => this.#getEnv(v)).filter((v): v is string => !!v)
      : POSIX_SYSTEM_PREFIXES;
  }

  /** Biến môi trường; Windows không phân biệt hoa thường. */
  #getEnv(name: string): string | undefined {
    if (!this.#win) return this.#env[name];
    const key = Object.keys(this.#env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? this.#env[key] : undefined;
  }

  #isInside(p: string, root: string): boolean {
    const rel = this.#p.relative(root, p);
    return rel === '' || (!rel.startsWith('..') && !this.#p.isAbsolute(rel));
  }

  /** Thay biến ở đầu từ: ~, $HOME, $env:X, ${env:X}, %X%, $X. Biến không biết thì để nguyên. */
  #expand(w: string): string {
    return w
      .replace(/^~(?=[\\/]|$)/, this.#home)
      .replace(/^\$(?:\{env:([A-Za-z_][\w()]*)\}|env:([A-Za-z_][\w()]*))/i, (m, a, b) => this.#getEnv(a ?? b) ?? m)
      .replace(/^%([A-Za-z_][\w()]*)%/, (m, a) => this.#getEnv(a) ?? m)
      .replace(/^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))(?=[\\/]|$)/, (m, a, b) => {
        const name = a ?? b;
        return name.toUpperCase() === 'HOME' ? this.#home : (this.#getEnv(name) ?? m);
      });
  }

  /** Biến một "từ" thành đường dẫn tuyệt đối nếu nó trông như đường dẫn đáng kiểm tra; ngược lại null. */
  toPath(word: string, cwd: string): string | null {
    let w = word.trim();
    if (!w || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return null; // URL
    w = this.#expand(w);
    if (/^[$%]/.test(w)) return null; // biến không biết giá trị
    // Chỉ lấy phần trước ký tự đại diện: /a/b/*.docx → /a/b
    const glob = w.search(/[*?]/);
    if (glob >= 0) w = w.slice(0, glob);
    if (this.#win) {
      // Tham số kiểu /s, /E của lệnh Windows; "/" đơn là phép chia.
      if (/^\/[A-Za-z0-9?]{0,4}$/.test(w) || w.startsWith('//')) return null;
      if (/^[A-Za-z]:[\\/]/.test(w) || w.startsWith('\\\\') || /^[\\/]/.test(w)) return this.#p.resolve(cwd, w);
    } else if (this.#p.isAbsolute(w)) {
      if (w === '/' || w.startsWith('//')) return null; // phép chia, chú thích, URL không giao thức
      return this.#p.resolve(w); // chuẩn hóa, bỏ "/" ở cuối
    }
    // Đường dẫn tương đối chỉ ra ngoài được khi có "..".
    if (/(^|[\\/])\.\.([\\/]|$)/.test(w)) return this.#p.resolve(cwd, w);
    return null;
  }

  #allowed(p: string): boolean {
    if (!this.#win && (POSIX_SYSTEM_FILES.has(p) || p.startsWith('/proc/self/'))) return true;
    if (this.#system.some((s) => this.#isInside(p, s))) return true;
    for (const root of [...this.roots(), ...(this.opts.extraAllowed ?? [])]) {
      if (root.endsWith('*')) {
        const prefix = root.slice(0, -1);
        if (this.#win ? p.toLowerCase().startsWith(prefix.toLowerCase()) : p.startsWith(prefix)) return true;
      } else if (this.#isInside(p, root)) {
        return true;
      }
    }
    return false;
  }

  /** Đường dẫn ngoài phạm vi trong một đoạn lệnh/script (kèm quét một tầng file script được gọi). */
  #scan(text: string, cwd: string, mode: ShellMode, out: Set<string>, depth: number) {
    for (const word of shellWords(text, mode)) {
      const p = this.toPath(word, cwd) ?? (depth === 0 && SCRIPT_EXT.test(word) ? this.#p.resolve(cwd, word) : null);
      if (!p) continue;
      if (!this.#allowed(p)) {
        out.add(p);
        continue;
      }
      // Script nằm trong phạm vi: đọc nội dung để xem nó có đụng tới file bên ngoài không.
      if (depth === 0 && SCRIPT_EXT.test(p) && !this.#system.some((s) => this.#isInside(p, s))) {
        try {
          if (statSync(p).size <= MAX_SCRIPT_BYTES) {
            // Nội dung script (Python, …) dùng chuỗi trong nháy như shell posix.
            this.#scan(readFileSync(p, 'utf8'), this.#p.dirname(p), /\.ps1$/i.test(p) ? 'powershell' : 'posix', out, 1);
          }
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
        const abs = this.#p.resolve(cwd, this.#expand(p));
        if (!this.#allowed(abs)) out.add(abs);
      }
    } else if (SEARCH_TOOLS.has(toolName)) {
      const p = str(input.path);
      if (p) {
        const abs = this.#p.resolve(cwd, this.#expand(p));
        if (!this.#allowed(abs)) out.add(abs);
      }
      const base = this.toPath(str(input.pattern), cwd);
      if (base && !this.#allowed(base)) out.add(base);
    } else if (SHELL_TOOLS[toolName]) {
      this.#scan(str(input.command), cwd, SHELL_TOOLS[toolName]!, out, 0);
    }
    return [...out];
  }

  /** Rút gọn đường dẫn để hiện cho người dùng: thay thư mục nhà bằng ~. */
  display(p: string): string {
    return this.#isInside(p, this.#home) ? `~${p.slice(this.#home.length)}` : p;
  }

  /** Công cụ này có thể đụng tới file trên máy hay không (để quyết định có cần kiểm tra). */
  static touchesFiles(toolName: string): boolean {
    return FILE_TOOLS.has(toolName) || SEARCH_TOOLS.has(toolName) || toolName in SHELL_TOOLS;
  }
}

/** Độ dài tối đa tên thư mục Claude Code đặt theo đường dẫn; dài hơn thì cắt và thêm mã băm. */
const MAX_SANITIZED = 200;

/**
 * Thư mục chứa scratchpad mà Claude Code cấp cho mỗi phiên của một thư mục làm việc:
 *   Linux/macOS: <tmp>/claude-<uid>/<tên>/<phiên>/scratchpad
 *   Windows:     <tmp>\claude\<tên>\<phiên>\scratchpad
 * <tên> là đường dẫn thư mục làm việc với ký tự không phải chữ/số thay bằng "-". Tên quá dài bị
 * cắt và thêm mã băm: khi đó trả về tiền tố kết thúc bằng "*".
 */
export function claudeScratchRoot(cwd: string, platform: NodeJS.Platform = process.platform, base?: string): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const root = base ?? (process.env.CLAUDE_CODE_TMPDIR || tmpdir());
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const dir = platform === 'win32' || uid === undefined ? 'claude' : `claude-${uid}`;
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= MAX_SANITIZED) return p.join(root, dir, name);
  return `${p.join(root, dir, name.slice(0, MAX_SANITIZED))}-*`;
}
