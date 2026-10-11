import { INSTALL_REASON } from './folderGuard.js';

/**
 * Chế độ "Lười biếng": giống auto của Claude Code — không hỏi gì, kể cả khi đụng file ngoài thư mục làm việc —
 * nhưng vẫn luôn CHẶN (không hỏi, từ chối và báo lại cho Claude) một số việc rủi ro cao:
 *   - xóa (hoặc chuyển đi) file nằm ngoài thư mục làm việc,
 *   - lệnh quyền quản trị / sửa cài đặt hệ thống,
 *   - đọc hay sửa file mật khẩu, khóa, thông tin đăng nhập.
 */

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** Lệnh xóa/chuyển file trong shell hoặc trong code chạy kèm (python -c, node -e…). */
const DELETE = new RegExp(
  [
    String.raw`(^|[\s;&|(])(rm|rmdir|unlink|shred|trash|del|erase|rd|mv|move)(\s|$)`,
    String.raw`\b(Remove-Item|Move-Item|ri)\b`,
    String.raw`\bos\.(remove|unlink|rmdir|removedirs|rename|replace)\s*\(`,
    String.raw`\bshutil\.(rmtree|move)\s*\(`,
    String.raw`\.unlink\s*\(|\.rmdir\s*\(|\bsend2trash\b`,
    String.raw`\b(unlinkSync|rmSync|rmdirSync|renameSync)\b|\bfs\.(promises\.)?(rm|unlink|rmdir|rename)\s*\(`,
  ].join('|'),
  'i',
);

/** Quyền quản trị và thay đổi cấu hình hệ thống. */
const ADMIN = new RegExp(
  [
    String.raw`(^|[\s;&|(])(sudo|su|doas|pkexec|runas)(\s|$)`,
    String.raw`-Verb\s+RunAs\b`,
    String.raw`(^|[\s;&|(])(systemctl|launchctl|bcdedit|diskpart|csrutil|spctl|nvram|shutdown|reboot|halt|poweroff|mkfs\S*|fdisk|dscl|visudo|chsh|passwd|crontab)(\s|$)`,
    String.raw`\breg(\.exe)?\s+(add|delete|import)\b`,
    String.raw`\b(Set|New|Remove)-ItemProperty\b[^\n]*\bHK(LM|CU)\b|\bHKLM:`,
    String.raw`\bdefaults\s+write\b`,
    String.raw`\b(Set-ExecutionPolicy|Disable-ComputerRestore|Stop-Computer|Restart-Computer)\b`,
    String.raw`\bformat\s+[a-z]:`,
  ].join('|'),
  'i',
);

/** File chứa mật khẩu, khóa, thông tin đăng nhập. */
const SECRETS = new RegExp(
  [
    String.raw`[\\/]\.ssh([\\/]|\b)`,
    String.raw`\bid_(rsa|dsa|ecdsa|ed25519)\b`,
    String.raw`[\\/]\.aws[\\/]credentials`,
    String.raw`[\\/]\.gnupg\b`,
    String.raw`[\\/]\.claude[\\/]\.credentials\.json`,
    String.raw`\.credentials\.json\b`,
    String.raw`[\\/]\.netrc\b|[\\/]\.git-credentials\b|[\\/]\.npmrc\b|[\\/]\.pypirc\b`,
    String.raw`[\\/]\.docker[\\/]config\.json`,
    String.raw`[\\/]\.kube[\\/]config`,
    String.raw`\bsecurity\s+(find|dump|export)-[\w-]*(password|keychain|certificate)`,
    String.raw`[\\/]Keychains[\\/]`,
    // Mật khẩu và cookie đã lưu của trình duyệt (tên file trong thư mục hồ sơ trình duyệt).
    // Phải là hết tên file (tiếp theo là dấu nháy — có thể đã bị thoát thành \" — hoặc hết chuỗi).
    String.raw`[\\/](Login Data|Cookies|Local State)(\\?["']|$)`,
    String.raw`\bcmdkey\b|\bvaultcmd\b|\bGet-StoredCredential\b`,
  ].join('|'),
  'i',
);

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Lý do chặn thao tác ở chế độ Lười biếng, hoặc null nếu cho phép.
 * `outside`: các đường dẫn ngoài thư mục làm việc mà thao tác đụng tới (FolderGuard tính).
 */
export function lazyBlockReason(toolName: string, input: Record<string, unknown>, outside: string[]): string | null {
  const command = SHELL_TOOLS.has(toolName) ? str(input.command) : '';
  // Mọi chuỗi trong đầu vào (đường dẫn file, mẫu tìm, lệnh…) để dò file bí mật.
  const allText = JSON.stringify(input);

  if (SECRETS.test(allText)) {
    return 'file mật khẩu, khóa hoặc thông tin đăng nhập';
  }
  if (command && ADMIN.test(command)) {
    return 'lệnh quyền quản trị hoặc sửa cài đặt hệ thống';
  }
  const realOutside = outside.filter((p) => p !== INSTALL_REASON); // cài phần mềm: Lười biếng cho phép
  if (command && realOutside.length > 0 && DELETE.test(command)) {
    return `xóa hoặc chuyển file ngoài thư mục đang mở (${realOutside.slice(0, 3).join(', ')})`;
  }
  return null;
}

/** Lời từ chối gửi lại Claude: nói rõ đây là chặn cố định, không phải người dùng từ chối. */
export function lazyDenyMessage(reason: string): string {
  return (
    `Chế độ "Lười biếng" của app luôn chặn thao tác này (${reason}). Đây là lớp bảo vệ cố định, không phải người dùng từ chối. ` +
    'Đừng thử cách khác để làm cùng việc đó; làm phần việc còn lại, rồi nói rõ với người dùng thao tác nào bị chặn và vì sao. ' +
    'Nếu thật sự cần, người dùng có thể chuyển sang chế độ "Hỏi trước" hoặc "Tự động" để tự duyệt.'
  );
}
