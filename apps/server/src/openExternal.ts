import { execFile, spawn } from 'node:child_process';
import { release } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Launcher = { command: string; args: string[] };

/** Đang chạy trong WSL: mở file bằng ứng dụng Windows (Word, Excel) thay vì ứng dụng Linux. */
export function isWsl(): boolean {
  return process.platform === 'linux' && (!!process.env.WSL_DISTRO_NAME || /microsoft/i.test(release()));
}

/**
 * Lệnh mở một file bằng ứng dụng mặc định của hệ điều hành.
 * WSL: explorer.exe nhận đường dẫn Windows (C:\…, hoặc \\wsl.localhost\… cho file trong Linux)
 * và mở bằng ứng dụng gắn với đuôi file. Tham số truyền thẳng (không qua shell) nên tên file
 * có dấu cách, dấu tiếng Việt không bị hỏng.
 */
export async function launcherFor(absPath: string, platform: NodeJS.Platform = process.platform, wsl = isWsl()): Promise<Launcher> {
  if (wsl) {
    const { stdout } = await execFileAsync('wslpath', ['-w', absPath]);
    return { command: 'explorer.exe', args: [stdout.trim()] };
  }
  if (platform === 'darwin') return { command: 'open', args: [absPath] };
  if (platform === 'win32') return { command: 'explorer.exe', args: [absPath] };
  return { command: 'xdg-open', args: [absPath] };
}

/** Mở file bằng ứng dụng ngoài và không chờ ứng dụng đóng. */
export async function openExternal(absPath: string): Promise<void> {
  const { command, args } = await launcherFor(absPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', (err) => reject(new Error(`Không mở được ứng dụng ngoài (${command}): ${err.message}`)));
    // explorer.exe trả mã thoát 1 cả khi mở thành công, nên chỉ coi lỗi khởi chạy là thất bại.
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
