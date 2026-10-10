// Lệnh gõ bằng "/" trong ô chat, theo kiểu Claude Code.
// "action": lệnh chạy ngay; "prompt": kỹ năng — điền sẵn câu lệnh mẫu để người dùng sửa rồi gửi.

export type CommandAction = 'clear' | 'compact' | 'context' | 'model' | 'mode' | 'login' | 'logout' | 'packs' | 'help';

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
  { name: 'cai-goi', description: 'Cài gói phân tích số liệu (thống kê, biểu đồ)', icon: 'codicon-cloud-download', kind: 'action', action: 'packs' },
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
  {
    name: 'phan-bien',
    description: 'Phản biện bài báo, chương sách, báo cáo như người phản biện tạp chí',
    icon: 'codicon-law',
    kind: 'prompt',
    template: 'Phản biện tài liệu sau như người phản biện tạp chí (gọi trợ lý phản biện tài liệu), nêu vấn đề theo mức độ, vị trí và đề xuất sửa: ',
  },
  {
    name: 'kiem-tra-trich-dan',
    description: 'Kiểm tra trích dẫn có thật và có ủng hộ nhận định không',
    icon: 'codicon-references',
    kind: 'prompt',
    template: 'Kiểm tra các trích dẫn trong tài liệu sau — bài có thật không, thông tin có đúng không, có ủng hộ nhận định không: ',
  },
  {
    name: 'tong-quan',
    description: 'Viết tổng quan tài liệu có bảng bằng chứng và trích dẫn',
    icon: 'codicon-library',
    kind: 'prompt',
    template:
      'Viết tổng quan tài liệu theo quy trình (tìm nguồn, lọc, bảng bằng chứng, tổng hợp), dẫn nguồn đầy đủ và lưu vào thư viện tài liệu tham khảo. Chủ đề: ',
  },
  {
    name: 'danh-gia-de',
    description: 'Đánh giá đề thi: đáp án, độ rõ ràng, phương án nhiễu, mức độ',
    icon: 'codicon-checklist',
    kind: 'prompt',
    template: 'Đánh giá đề thi sau (gọi trợ lý đánh giá đề thi): kiểm tra đáp án đối chiếu tài liệu, độ rõ ràng, phương án nhiễu, mức độ nhận thức: ',
  },
  {
    name: 'nhan-xet-word',
    description: 'Ghi nhận xét vào lề file Word (bản sao, không sửa nội dung)',
    icon: 'codicon-comment',
    kind: 'prompt',
    template: 'Đọc file Word sau và ghi nhận xét cụ thể vào lề (ghi ra bản sao, không sửa nội dung gốc): ',
  },
  {
    name: 'xuat-word',
    description: 'Xuất bài viết ra Word kèm trích dẫn và tài liệu tham khảo',
    icon: 'codicon-file-text',
    kind: 'prompt',
    template: 'Xuất bài viết sau ra Word, định dạng trích dẫn và danh mục tài liệu tham khảo theo chuẩn của thư mục: ',
  },
  {
    name: 'ocr',
    description: 'Nhận dạng chữ trang ảnh quét trong PDF để đọc và tìm được',
    icon: 'codicon-symbol-text',
    kind: 'prompt',
    template: 'Nhận dạng chữ các trang ảnh quét trong file PDF sau (lưu lại để lần sau đọc và tìm được): ',
  },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}
