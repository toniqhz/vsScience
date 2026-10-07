// Lệnh gõ bằng "/" trong ô chat, theo kiểu Claude Code.
// "action": lệnh chạy ngay; "prompt": kỹ năng — điền sẵn câu lệnh mẫu để người dùng sửa rồi gửi.

export type CommandAction = 'clear' | 'compact' | 'context' | 'model' | 'mode' | 'login' | 'logout' | 'help';

export type Command =
  | { name: string; description: string; icon: string; kind: 'action'; action: CommandAction }
  | { name: string; description: string; icon: string; kind: 'prompt'; template: string };

export const COMMANDS: Command[] = [
  { name: 'clear', description: 'Xóa hội thoại, bắt đầu phiên mới', icon: 'codicon-clear-all', kind: 'action', action: 'clear' },
  { name: 'compact', description: 'Tóm gọn hội thoại để giải phóng ngữ cảnh', icon: 'codicon-fold', kind: 'action', action: 'compact' },
  { name: 'context', description: 'Xem mức dùng cửa sổ ngữ cảnh', icon: 'codicon-pie-chart', kind: 'action', action: 'context' },
  { name: 'model', description: 'Đổi model và mức suy nghĩ', icon: 'codicon-sparkle', kind: 'action', action: 'model' },
  { name: 'mode', description: 'Đổi chế độ: hỏi trước / tự động / lập kế hoạch', icon: 'codicon-shield', kind: 'action', action: 'mode' },
  { name: 'login', description: 'Đăng nhập tài khoản Claude', icon: 'codicon-account', kind: 'action', action: 'login' },
  { name: 'logout', description: 'Đăng xuất tài khoản Claude trên máy này', icon: 'codicon-sign-out', kind: 'action', action: 'logout' },
  { name: 'help', description: 'Danh sách lệnh và phím tắt', icon: 'codicon-question', kind: 'action', action: 'help' },
  {
    name: 'soan-trac-nghiem',
    description: 'Soạn câu trắc nghiệm kèm số trang nguồn',
    icon: 'codicon-checklist',
    kind: 'prompt',
    template: 'Soạn 10 câu trắc nghiệm 4 lựa chọn từ ',
  },
  {
    name: 'tom-tat',
    description: 'Tóm tắt tài liệu, ghi số trang cho từng ý',
    icon: 'codicon-book',
    kind: 'prompt',
    template: 'Tóm tắt tài liệu sau, ghi số trang cho từng ý chính: ',
  },
  {
    name: 'tron-de',
    description: 'Trộn đề thành nhiều mã đề và xuất đáp án',
    icon: 'codicon-symbol-array',
    kind: 'prompt',
    template: 'Trộn đề sau thành 4 mã đề A, B, C, D và xuất bảng đáp án: ',
  },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}
