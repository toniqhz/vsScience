import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Môi trường chạy đi kèm app desktop: Python portable có sẵn thư viện xử lý tài liệu, cộng các gói
 * tùy chọn người dùng đã cài (thư mục IDE_PYTHON_PACKS_DIR/<gói>). Khi chạy dev thì dùng Python của máy.
 */
export function pythonHome(): string | null {
  return process.env.IDE_PYTHON_HOME || null;
}

export function packsDir(): string | null {
  return process.env.IDE_PYTHON_PACKS_DIR || null;
}

/** Tệp đánh dấu gói đã cài xong (ghi sau khi pip chạy thành công). */
export const INSTALLED_MARKER = '.installed';

/** Thư mục các gói tùy chọn đã cài xong. */
export function installedPackDirs(dir = packsDir()): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((id) => !id.startsWith('.') && existsSync(path.join(dir, id, INSTALLED_MARKER)))
    .sort()
    .map((id) => path.join(dir, id));
}

/** Đổi khi cài thêm gói: phiên Claude cần khởi động lại để thấy thư viện và hướng dẫn mới. */
export function runtimeKey(): string {
  return installedPackDirs()
    .map((d) => path.basename(d))
    .join(',');
}

/** Lệnh chạy Python: bản đi kèm app, hoặc Python của máy khi chạy dev. */
export function pythonExe(home = pythonHome(), platform = process.platform): string {
  if (!home) return platform === 'win32' ? 'python' : 'python3';
  return platform === 'win32' ? path.win32.join(home, 'python.exe') : path.posix.join(home, 'bin', 'python3');
}

/** Thư mục chứa python(.exe) cần đưa lên đầu PATH. */
function pythonPathDirs(home: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? [home, path.win32.join(home, 'Scripts')] : [path.posix.join(home, 'bin')];
}

/**
 * Thêm Python đi kèm vào môi trường của Claude Code CLI (và mọi lệnh nó chạy).
 * Windows: process.env không phân biệt hoa thường nhưng bản sao thì có ("Path" vs "PATH"),
 * nên sửa đúng khóa đang có để không tạo hai biến PATH.
 */
export function withRuntime(
  env: NodeJS.ProcessEnv,
  home = pythonHome(),
  platform = process.platform,
  extraDirs = installedPackDirs(),
): NodeJS.ProcessEnv {
  if (!home) return env;
  const out = { ...env };
  const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const sep = platform === 'win32' ? ';' : ':';
  out[key] = [...pythonPathDirs(home, platform), out[key]].filter(Boolean).join(sep);
  // Gói tùy chọn đã cài nằm ngoài thư mục app (thư mục dữ liệu người dùng).
  if (extraDirs.length) out.PYTHONPATH = [...extraDirs, out.PYTHONPATH].filter(Boolean).join(sep);
  // Windows mặc định in ra theo cp1252: chữ tiếng Việt làm script lỗi. Bật UTF-8 cho mọi script.
  out.PYTHONUTF8 = '1';
  out.PYTHONIOENCODING = 'utf-8';
  // Không lẫn thư viện cài riêng của người dùng; không ghi __pycache__ vào thư mục app (có thể chỉ đọc).
  out.PYTHONNOUSERSITE = '1';
  out.PYTHONDONTWRITEBYTECODE = '1';
  // Vẽ hình ra file, không mở cửa sổ.
  out.MPLBACKEND = 'Agg';
  return out;
}

/** Ghi chú cho system prompt: Claude biết có Python và thư viện nào, không tự cài thêm. */
export function runtimePrompt(home = pythonHome(), platform = process.platform, packs = runtimeKey().split(',').filter(Boolean)): string | null {
  if (!home) return null;
  const shell = platform === 'win32' ? 'PowerShell' : 'shell';
  const data = packs.includes('data');
  const libs = ['python-docx (Word)', 'openpyxl và xlrd (Excel)', 'python-pptx (PowerPoint)', 'PyMuPDF/fitz (PDF)', ...(data ? ['pandas', 'numpy', 'scipy', 'matplotlib'] : [])];
  return `# Công cụ có sẵn trên máy
- Python 3.12 đi kèm app, gọi bằng lệnh \`python\` trong ${shell}, đã có: ${libs.join(', ')}.
- Không cài thêm thư viện (không pip install). Thiếu thư viện thì làm cách khác hoặc báo người dùng.${
    data
      ? '\n- Vẽ hình bằng matplotlib thì lưu ra file (không gọi plt.show()).'
      : '\n- Chưa cài "Gói phân tích số liệu" (pandas, numpy, scipy, matplotlib). Việc cần các thư viện này (thống kê, kiểm định, vẽ biểu đồ, bảng số liệu lớn) thì làm bằng Python thuần nếu đơn giản; nếu không, nói người dùng gõ lệnh /cai-goi trong ô chat để cài gói này (tải khoảng 80 MB), rồi làm tiếp.'
  }${
    platform === 'win32'
      ? '\n- Máy dùng Windows: chạy lệnh bằng PowerShell; đường dẫn có dấu cách hoặc tiếng Việt phải đặt trong nháy. Viết script Python ra file trong scratchpad rồi chạy, tránh dồn code dài vào một dòng lệnh.'
      : ''
  }`;
}
