import { describe, expect, it } from 'vitest';
import { isWsl, launcherFor } from '../src/openExternal.js';

describe('lệnh mở file bằng ứng dụng ngoài', () => {
  it('macOS, Windows, Linux dùng lệnh mở mặc định của hệ', async () => {
    expect(await launcherFor('/a/Đề 1.docx', 'darwin', false)).toEqual({ command: 'open', args: ['/a/Đề 1.docx'] });
    expect(await launcherFor('C:\\a\\Đề 1.docx', 'win32', false)).toEqual({ command: 'explorer.exe', args: ['C:\\a\\Đề 1.docx'] });
    expect(await launcherFor('/a/Đề 1.docx', 'linux', false)).toEqual({ command: 'xdg-open', args: ['/a/Đề 1.docx'] });
  });

  it.runIf(isWsl())('WSL: đổi sang đường dẫn Windows rồi mở bằng explorer.exe', async () => {
    expect(await launcherFor('/mnt/c/Users/Tuan Nguyen/Đề 1.docx')).toEqual({
      command: 'explorer.exe',
      args: ['C:\\Users\\Tuan Nguyen\\Đề 1.docx'],
    });
    const linux = await launcherFor('/home/ai-do/Đề thi/Đề.xlsx');
    expect(linux.args[0]).toMatch(/^\\\\wsl(\.localhost|\$)\\[^\\]+\\home\\ai-do\\Đề thi\\Đề\.xlsx$/);
  });
});
