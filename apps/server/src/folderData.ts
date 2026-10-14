import { execFile } from 'node:child_process';
import { cp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Dữ liệu của app gắn với một thư mục làm việc (đoạn chat với Claude, bản lưu, artifact, cài đặt của thư mục)
 * nằm ngay trong thư mục đó, ở thư mục ẩn `.vsscience/`. Chuyển, đổi tên hay đồng bộ thư mục sang máy khác
 * thì dữ liệu đi theo.
 */
export const DATA_DIR = '.vsscience';

export function folderDataPath(root: string, ...parts: string[]): string {
  return path.join(root, DATA_DIR, ...parts);
}

const README = `Thư mục này chứa dữ liệu của VsScience cho thư mục làm việc này:
  sessions/   các đoạn chat với Claude
  history/    các bản lưu (mục Thay đổi)
  artifacts/  trang Claude đã đăng (bản sao HTML)
  settings.json  cài đặt của thư mục
Đừng xóa hoặc sửa tay. Khi chép hay đồng bộ thư mục làm việc sang máy khác, hãy chép cả thư mục này.
`;

const ready = new Map<string, Promise<boolean>>();

/**
 * Tạo `.vsscience/` (ẩn trên Windows). Trả về false nếu thư mục làm việc không ghi được
 * (ổ chỉ đọc, thư mục hệ thống…): khi đó app dùng thư mục dữ liệu của app như trước.
 */
export function ensureFolderData(root: string): Promise<boolean> {
  let p = ready.get(root);
  if (!p) {
    p = (async () => {
      const dir = folderDataPath(root);
      try {
        const existed = await exists(dir);
        await mkdir(dir, { recursive: true });
        if (!existed) {
          await writeFile(path.join(dir, 'README.txt'), README);
          // Windows không coi tên bắt đầu bằng dấu chấm là ẩn: đặt thuộc tính ẩn cho gọn mắt.
          if (process.platform === 'win32') execFile('attrib', ['+h', dir], { windowsHide: true }, () => {});
        }
        return true;
      } catch {
        return false;
      }
    })();
    ready.set(root, p);
  }
  return p;
}

export async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** Chuyển thư mục dữ liệu cũ sang chỗ mới (chỉ khi chỗ mới chưa có). Trả về true nếu đã chuyển. */
export async function migrateDir(from: string, to: string): Promise<boolean> {
  if (!(await exists(from)) || (await exists(to))) return false;
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch {
    // Khác ổ đĩa: chép rồi xóa bản cũ.
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
  return true;
}
