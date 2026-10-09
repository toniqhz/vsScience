// Kiểu dữ liệu dùng chung giữa server và web.
// Chỉ chứa type (import bằng `import type`) để không phát sinh mã chạy.

/** Ba loại file người dùng làm việc chính. */
/** Loại file để chọn cách xem; 'other' là file khác (zip, video…) chỉ mở được bằng ứng dụng trên máy. */
export type FileKind = 'pdf' | 'word' | 'excel' | 'powerpoint' | 'markdown' | 'text' | 'html' | 'image' | 'other';

export interface TreeNode {
  /** Đường dẫn tương đối kiểu POSIX tính từ thư mục làm việc; gốc là "". */
  id: string;
  name: string;
  type: 'folder' | 'file';
  kind?: FileKind;
  size?: number;
  /** Thời điểm sửa cuối (ms since epoch). */
  mtime?: number;
  children?: TreeNode[];
}

export interface WorkspaceInfo {
  name: string;
  root: string;
  /** Các thư mục mở gần đây (đường dẫn tuyệt đối), mới nhất trước. */
  recent: string[];
}

export interface DirEntry {
  name: string;
  /** Đường dẫn tuyệt đối trên máy. */
  path: string;
}

/** Kết quả duyệt thư mục cho hộp thoại "Mở thư mục". */
export interface DirListing {
  path: string;
  /** null nếu đang ở gốc ổ đĩa. */
  parent: string | null;
  dirs: DirEntry[];
  /** Lối tắt: thư mục cá nhân, Tài liệu, Màn hình nền, Tải về… */
  shortcuts: DirEntry[];
}

/** Trạng thái đăng nhập Claude (theo `claude auth status` của Claude Code CLI). */
export interface AuthStatus {
  loggedIn: boolean;
  /** claude.ai | oauth_token | api_key | api_key_helper | third_party | none */
  method: string;
  email: string | null;
  /** Gói thuê bao, ví dụ "pro", "max". */
  plan: string | null;
  orgName: string | null;
  /** Lỗi khi không chạy được CLI (ví dụ thiếu file). */
  error?: string;
}

/** Tiến trình đăng nhập đang chạy (`claude auth login`). */
export interface LoginProgress {
  state: 'idle' | 'waiting' | 'success' | 'error';
  /** Link mở trình duyệt, tự gọi về CLI sau khi cấp quyền (như plugin VS Code). */
  autoUrl: string | null;
  /** Link dự phòng: trang web hiện mã để dán lại vào app. */
  manualUrl: string | null;
  message: string | null;
}

export interface TreeResponse {
  root: TreeNode;
  /** true nếu cây bị cắt bớt vì quá nhiều mục hoặc quá sâu. */
  truncated: boolean;
}

export type FsEventType = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

// ---------- Trợ lý (Claude Agent SDK) ----------

export type AgentMode = 'ask' | 'auto' | 'plan';

/** Khối nội dung của câu trả lời, đã rút gọn từ Claude API. */
export type AgentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'thinking'; text: string };

/** Thay đổi file do Claude sửa (lấy từ kết quả của công cụ Edit/Write). */
export interface FileChange {
  /** Đường dẫn tương đối trong thư mục làm việc (hoặc tuyệt đối nếu nằm ngoài). */
  path: string;
  kind: 'edit' | 'create';
  additions: number;
  deletions: number;
  hunks: { oldStart: number; newStart: number; lines: string[] }[];
}

export interface ContextUsage {
  used: number;
  max: number;
  percentage: number;
  categories: { name: string; tokens: number }[];
}

/**
 * Sự kiện của phiên trợ lý. Server giữ nhật ký sự kiện của phiên hiện tại và gửi lại
 * toàn bộ khi trình duyệt kết nối, nên tải lại trang không mất hội thoại.
 */
export type AgentEvent =
  | { kind: 'user'; id: string; text: string; files: string[] }
  | { kind: 'status'; state: 'idle' | 'running' }
  /** Chữ đang được viết dở (stream) cho khối `index` của tin nhắn `messageId`. */
  | { kind: 'delta'; messageId: string; index: number; text: string }
  /** Khối đã hoàn chỉnh, thay cho phần chữ stream dở cùng vị trí. */
  | { kind: 'block'; messageId: string; index: number; block: AgentBlock }
  | { kind: 'tool-result'; toolUseId: string; isError: boolean; output: string; fileChange?: FileChange }
  | {
      kind: 'permission';
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      fileChange?: FileChange;
      /** Đường dẫn nằm ngoài thư mục làm việc mà thao tác này đụng tới (lý do phải hỏi). */
      outside?: string[];
    }
  | { kind: 'permission-resolved'; id: string; allowed: boolean }
  /** Kết thúc một lượt. `interrupted`: người dùng bấm dừng. */
  | { kind: 'result'; isError: boolean; durationMs: number; message?: string; interrupted?: boolean }
  | { kind: 'context'; usage: ContextUsage }
  | { kind: 'error'; message: string }
  | { kind: 'cleared' };

/** Hồ sơ Claude dựng sẵn đang dùng (quy trình, giọng trả lời, subagent). */
export interface ClaudeProfileInfo {
  dir: string;
  /** Tên output style (giọng trả lời), nếu có. */
  outputStyle: string | null;
  agents: { name: string; description: string }[];
  /** Có CLAUDE.md (quy trình làm việc chung). */
  hasInstructions: boolean;
}

/** Một phiên hội thoại Claude đã lưu (của thư mục làm việc hiện tại). */
export interface AgentSessionInfo {
  id: string;
  title: string;
  lastModified: number;
  current: boolean;
}

// ---------- Bản lưu (git chạy ngầm) ----------

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
}

export interface Snapshot {
  id: string;
  message: string;
  time: number;
}

/** Một bản lưu và các file thay đổi trong bản đó so với bản ngay trước. */
export interface SnapshotDetail {
  snapshot: Snapshot;
  files: ChangedFile[];
}

/** Kết quả khôi phục về một bản lưu. */
export interface RestoreResult {
  restored: number;
  removed: number;
  /** Tên bản lưu đang giữ trạng thái ngay trước khi khôi phục (để quay lại). */
  backup: string;
}

export interface ChangesResponse {
  files: ChangedFile[];
  snapshots: Snapshot[];
}

/** Diff một file so với bản lưu gần nhất. Word so theo đoạn văn, Excel theo ô. */
export interface FileDiff {
  path: string;
  /** null: file không còn khác bản lưu gần nhất. */
  status: ChangeStatus | null;
  /** null nếu không so được nội dung (ví dụ PDF). */
  change: FileChange | null;
  note?: string;
}

/** Thông điệp server đẩy qua WebSocket /api/events. */
/** Một cửa sổ hạn mức của gói Claude.ai (phiên 5 giờ hoặc tuần). */
export interface UsageWindow {
  /** Phần trăm đã dùng, 0–100. */
  percent: number;
  /** Thời điểm đặt lại (ISO 8601). */
  resetsAt: string | null;
}

/** Hạn mức sử dụng gói Claude.ai, như lệnh /usage của Claude Code. */
export interface PlanUsage {
  plan: string | null;
  session: UsageWindow | null;
  weekly: UsageWindow | null;
  /** Thời điểm lấy số liệu (ms). */
  updatedAt: number;
}

/** Gói tùy chọn (thư viện Python cài thêm khi người dùng đồng ý), ví dụ gói phân tích số liệu. */
/** Thư mục trong thư mục làm việc chứa sản phẩm Claude viết cho người dùng (ghi chú .md, trang .html…). */
export const ARTIFACT_FOLDER = 'artifact';

/**
 * Sản phẩm Claude tạo ra khi làm việc với thư mục này: file mới trong thư mục (ghi chú, bản tóm tắt, đề…)
 * hoặc trang đăng lên claude.ai.
 */
export interface ArtifactInfo {
  id: string;
  /** 'file': file trong thư mục làm việc (xem bằng khung xem file); 'published': trang trên claude.ai (có bản sao HTML). */
  source: 'file' | 'published';
  /** Đường dẫn tương đối của file (source 'file'). */
  path?: string;
  /** Trang đã đăng: 'page' là trang HTML (có bản sao trên máy), 'doc' là tài liệu Claude Docs (chỉ có trên claude.ai). */
  kind?: 'page' | 'doc';
  /** Có bản sao HTML trên máy để xem ngay trong app. */
  local?: boolean;
  title: string;
  description?: string;
  /** Link trên claude.ai; null nếu không đọc được từ kết quả. */
  url: string | null;
  /** Tên file HTML Claude đã viết. */
  fileName: string;
  createdAt: number;
  updatedAt: number;
}

export interface PackInfo {
  id: string;
  title: string;
  packages: string[];
  downloadBytes: number;
  installedBytes: number;
  state: 'missing' | 'installing' | 'installed' | 'error';
  /** Tiến độ khi đang cài: số file đã xử lý / tổng. */
  progress?: { done: number; total: number };
  message?: string;
}

export type ServerEvent =
  | { type: 'hello'; workspace: WorkspaceInfo }
  | { type: 'fs'; changes: { event: FsEventType; path: string }[] }
  | { type: 'agent'; event: AgentEvent }
  | { type: 'agent-replay'; events: AgentEvent[] }
  /** Danh sách phiên hoặc bản lưu vừa đổi — giao diện tải lại khi cần. */
  | { type: 'sessions-changed' }
  | { type: 'changes-changed' }
  | { type: 'artifacts-changed' }
  | { type: 'usage'; usage: PlanUsage }
  | { type: 'pack'; pack: PackInfo };
