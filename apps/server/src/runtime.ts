import path from 'node:path';

/**
 * Môi trường chạy đi kèm app desktop (Python portable có sẵn thư viện xử lý tài liệu).
 * App desktop đặt IDE_PYTHON_HOME; khi chạy dev thì dùng Python của máy.
 */
export function pythonHome(): string | null {
  return process.env.IDE_PYTHON_HOME || null;
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
export function withRuntime(env: NodeJS.ProcessEnv, home = pythonHome(), platform = process.platform): NodeJS.ProcessEnv {
  if (!home) return env;
  const out = { ...env };
  const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const sep = platform === 'win32' ? ';' : ':';
  out[key] = [...pythonPathDirs(home, platform), out[key]].filter(Boolean).join(sep);
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
export function runtimePrompt(home = pythonHome(), platform = process.platform): string | null {
  if (!home) return null;
  const shell = platform === 'win32' ? 'PowerShell' : 'shell';
  return `# Công cụ có sẵn trên máy
- Python 3.12 đi kèm app, gọi bằng lệnh \`python\` trong ${shell}, đã có: python-docx (Word), openpyxl và xlrd (Excel), PyMuPDF/fitz (PDF), pandas, numpy, scipy, matplotlib.
- Không cài thêm thư viện (không pip install). Thiếu thư viện thì làm cách khác hoặc báo người dùng.
- Vẽ hình bằng matplotlib thì lưu ra file (không gọi plt.show()).${
    platform === 'win32'
      ? '\n- Máy dùng Windows: chạy lệnh bằng PowerShell; đường dẫn có dấu cách hoặc tiếng Việt phải đặt trong nháy. Viết script Python ra file trong scratchpad rồi chạy, tránh dồn code dài vào một dòng lệnh.'
      : ''
  }`;
}
