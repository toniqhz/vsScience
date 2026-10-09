import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FileKind } from '@ide/shared';

const KIND_BY_EXT: Record<string, FileKind> = {
  '.pdf': 'pdf',
  '.docx': 'word',
  '.doc': 'word',
  '.xlsx': 'excel',
  '.xlsm': 'excel',
  '.xls': 'excel',
  '.csv': 'excel',
  '.pptx': 'powerpoint',
  '.ppt': 'powerpoint',
  // Ghi chú, bản tóm tắt, trang HTML mà Claude hay viết ra.
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.html': 'html',
  '.htm': 'html',
  ...Object.fromEntries(
    ['.json', '.xml', '.yml', '.yaml', '.log', '.ini', '.tex', '.bib', '.ris', '.py', '.r', '.js', '.ts', '.css', '.sh', '.ps1', '.bat', '.tsv', '.srt']
      .map((e) => [e, 'text' as const]),
  ),
  ...Object.fromEntries(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'].map((e) => [e, 'image' as const])),
};

export const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv; charset=utf-8',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  // Trả HTML dưới dạng chữ: không để trang trong thư mục chạy cùng nguồn với app (app tự hiển thị trong khung cách ly).
  '.html': 'text/plain; charset=utf-8',
  '.htm': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  // SVG có thể chứa script: trả dạng chữ, app tự hiển thị qua thẻ <img> (không chạy script).
  '.svg': 'text/plain; charset=utf-8',
};

/** File chạy được (chương trình, script): không mở bằng ứng dụng mặc định từ app, vì mở tức là chạy. */
const EXECUTABLE_EXT = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.pif', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.hta', '.lnk', '.jar', '.py', '.pyw', '.sh', '.command', '.app', '.pkg', '.dmg', '.reg', '.cpl', '.url',
]);

export function isExecutable(name: string): boolean {
  return EXECUTABLE_EXT.has(path.extname(name).toLowerCase());
}

/** File hệ thống mà File Explorer / Finder cũng ẩn. */
const HIDDEN_SYSTEM_FILES = new Set(['desktop.ini', 'thumbs.db', 'ehthumbs.db', 'icon\r']);

const IGNORED_NAMES = new Set([
  'node_modules',
  '__pycache__',
  '$RECYCLE.BIN',
  'System Volume Information',
]);

/** Mọi file đều hiện (như File Explorer); loại quyết định cách xem trong app. */
export function fileKind(name: string): FileKind {
  return KIND_BY_EXT[path.extname(name).toLowerCase()] ?? 'other';
}

/** Mục không bao giờ hiện cho người dùng: file ẩn, file khóa của Office/LibreOffice, thư mục hệ thống. */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~$') || IGNORED_NAMES.has(name) || HIDDEN_SYSTEM_FILES.has(name.toLowerCase());
}

export class PathError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Chuyển đường dẫn tương đối (POSIX, do client gửi) thành đường dẫn tuyệt đối
 * nằm chắc chắn trong thư mục làm việc. Chặn "..", đường dẫn tuyệt đối, mục ẩn,
 * và symlink trỏ ra ngoài. `root` phải là đường dẫn đã realpath.
 */
export async function resolveInWorkspace(root: string, relPath: string): Promise<string> {
  if (relPath.includes('\0')) throw new PathError('Đường dẫn không hợp lệ', 400);
  const parts = relPath.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..' || isHiddenName(p))) {
    throw new PathError('Đường dẫn không hợp lệ', 400);
  }
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new PathError('Đường dẫn không hợp lệ', 400);
  }
  const joined = path.join(root, ...parts);
  let real: string;
  try {
    real = await realpath(joined);
  } catch {
    throw new PathError('Không tìm thấy', 404);
  }
  if (!isInside(root, real)) throw new PathError('Không tìm thấy', 404);
  return real;
}

/** Đường dẫn tuyệt đối → tương đối kiểu POSIX dùng làm id phía client. */
export function toRelPosix(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Kiểm tra tên file/thư mục mới người dùng gõ. Dùng luật chặt nhất (Windows)
 * để thư mục làm việc chép sang máy khác vẫn dùng được.
 */
export function validateNewName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new PathError('Tên không được để trống', 400);
  if (trimmed.length > 200) throw new PathError('Tên quá dài', 400);
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(trimmed)) {
    throw new PathError('Tên không được chứa các ký tự < > : " / \\ | ? *', 400);
  }
  if (trimmed.endsWith('.')) throw new PathError('Tên không được kết thúc bằng dấu chấm', 400);
  if (isHiddenName(trimmed) || trimmed === '..') throw new PathError('Tên không được bắt đầu bằng dấu chấm hoặc ~$', 400);
  if (WINDOWS_RESERVED.test(trimmed)) throw new PathError('Tên này bị hệ điều hành dành riêng', 400);
  return trimmed;
}
