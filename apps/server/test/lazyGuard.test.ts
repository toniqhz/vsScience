import { describe, expect, it } from 'vitest';
import { INSTALL_REASON } from '../src/folderGuard.js';
import { lazyBlockReason } from '../src/lazyGuard.js';

const bash = (command: string, outside: string[] = []) => lazyBlockReason('Bash', { command }, outside);
const ps = (command: string, outside: string[] = []) => lazyBlockReason('PowerShell', { command }, outside);

describe('chế độ Lười biếng: vẫn cho phép', () => {
  it('đọc, sửa, tạo file ngoài thư mục; cài thư viện; xóa file trong thư mục', () => {
    expect(bash('cat ~/Downloads/de-thi.docx', ['/home/a/Downloads/de-thi.docx'])).toBeNull();
    expect(lazyBlockReason('Write', { file_path: '/home/a/Desktop/tong-ket.md', content: 'x' }, ['/home/a/Desktop/tong-ket.md'])).toBeNull();
    expect(bash('pip install pandas', [INSTALL_REASON])).toBeNull();
    expect(bash('rm "Bản nháp cũ.docx"')).toBeNull();
    expect(bash('mv a.md artifact/a.md')).toBeNull();
    expect(bash('python3 -c "import os; os.remove(\'tam.txt\')"')).toBeNull();
    expect(lazyBlockReason('Read', { file_path: '/home/a/Tài liệu/Cookies và bánh.pdf' }, ['/home/a/Tài liệu/Cookies và bánh.pdf'])).toBeNull();
    expect(lazyBlockReason('mcp__claude_ai_Consensus__search', { query: 'PCR' }, [])).toBeNull();
  });
});

describe('chế độ Lười biếng: luôn chặn', () => {
  it('xóa hoặc chuyển file ngoài thư mục', () => {
    expect(bash('rm -rf ~/Documents/cu', ['/home/a/Documents/cu'])).toMatch(/xóa/);
    expect(bash('mv ~/Desktop/a.docx /tmp/x', ['/home/a/Desktop/a.docx'])).toMatch(/xóa/);
    expect(ps('Remove-Item -Recurse "C:\\Users\\a\\Desktop\\Cũ"', ['C:\\Users\\a\\Desktop\\Cũ'])).toMatch(/xóa/);
    expect(bash('python3 -c "import shutil; shutil.rmtree(\'/home/a/Pictures\')"', ['/home/a/Pictures'])).toMatch(/xóa/);
  });

  it('lệnh quyền quản trị, sửa cài đặt hệ thống', () => {
    expect(bash('sudo apt-get install poppler-utils')).toMatch(/quản trị/);
    expect(bash('ls && sudo rm x')).toMatch(/quản trị/);
    expect(ps('Start-Process powershell -Verb RunAs')).toMatch(/quản trị/);
    expect(ps('reg add HKCU\\Software\\X /v Y /d 1')).toMatch(/quản trị/);
    expect(bash('defaults write com.apple.finder AppleShowAllFiles YES')).toMatch(/quản trị/);
  });

  it('file mật khẩu, khóa, thông tin đăng nhập', () => {
    expect(bash('cat ~/.ssh/id_ed25519')).toMatch(/mật khẩu/);
    expect(lazyBlockReason('Read', { file_path: '/home/a/.claude/.credentials.json' }, ['/home/a/.claude/.credentials.json'])).toMatch(/mật khẩu/);
    expect(lazyBlockReason('Grep', { pattern: 'token', path: '/home/a/.aws/credentials' }, [])).toMatch(/mật khẩu/);
    expect(bash('security find-generic-password -s Chrome')).toMatch(/mật khẩu/);
    expect(bash('cp "/home/a/.config/google-chrome/Default/Login Data" /tmp/x')).toMatch(/mật khẩu/);
  });
});
