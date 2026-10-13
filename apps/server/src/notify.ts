import type { AgentEvent } from '@ide/shared';

/** Thông báo của hệ điều hành khi Claude cần người dùng (app desktop hiện, chỉ khi cửa sổ không được xem). */
export interface AppNotification {
  kind: 'done' | 'question' | 'permission' | 'error';
  title: string;
  body: string;
}

const MAX_BODY = 160;

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** Bỏ ký hiệu Markdown để đọc được trong thông báo. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?:<[^>]*>|[^)]*)\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s: string, max = MAX_BODY): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Câu hỏi cuối câu trả lời (dòng cuối kết thúc bằng "?"), nếu có. */
export function trailingQuestion(md: string): string | null {
  const lines = md
    .split('\n')
    .map((l) => plainText(l))
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last || !/[?？]\s*["”')\]]*$/.test(last)) return null;
  // Lấy câu chứa dấu hỏi (bỏ phần dẫn dài phía trước trong cùng dòng).
  const sentences = last.split(/(?<=[.!])\s+/);
  return sentences.at(-1) ?? last;
}

function describePermission(toolName: string, input: Record<string, unknown>, outside?: string[]): string {
  if (outside?.length) return `Đụng tới file ngoài thư mục đang mở: ${outside.slice(0, 2).map(base).join(', ')}`;
  if (FILE_TOOLS.has(toolName)) {
    const file = base(str(input.file_path) || str(input.notebook_path));
    return toolName === 'Read' ? `Đọc ${file}` : `Sửa ${file}`;
  }
  if (SHELL_TOOLS.has(toolName)) return str(input.description) || `Chạy lệnh: ${str(input.command)}`;
  if (toolName === 'WebFetch') return `Mở trang ${str(input.url)}`;
  if (toolName === 'WebSearch') return `Tìm trên mạng: ${str(input.query)}`;
  return `Dùng công cụ ${toolName.split('__').at(-1)}`;
}

/**
 * Theo dõi sự kiện của phiên Claude và cho biết khi nào cần báo người dùng:
 * xong một lượt (trả lời xong hoặc làm xong việc), hỏi lại ở cuối câu trả lời, cần cho phép, gặp lỗi.
 */
export class TurnNotifier {
  #lastText = '';
  #usedTools = false;

  constructor(private readonly folder: () => string) {}

  next(event: AgentEvent): AppNotification | null {
    switch (event.kind) {
      case 'user':
        this.#lastText = '';
        this.#usedTools = false;
        return null;
      case 'block':
        if (event.block.type === 'text' && event.block.text.trim()) this.#lastText = event.block.text;
        if (event.block.type === 'tool_use') this.#usedTools = true;
        return null;
      case 'permission':
        return {
          kind: 'permission',
          title: 'Claude cần bạn cho phép',
          body: this.#withFolder(describePermission(event.toolName, event.input, event.outside)),
        };
      case 'result': {
        if (event.interrupted) return null;
        const text = this.#lastText;
        this.#lastText = '';
        if (event.isError) {
          return { kind: 'error', title: 'Claude gặp lỗi', body: this.#withFolder(event.message || 'Lượt làm việc dừng giữa chừng') };
        }
        const question = trailingQuestion(text);
        if (question) return { kind: 'question', title: 'Claude đang hỏi bạn', body: this.#withFolder(question) };
        return {
          kind: 'done',
          title: this.#usedTools ? 'Claude đã làm xong' : 'Claude đã trả lời xong',
          body: this.#withFolder(plainText(text) || 'Mở app để xem kết quả'),
        };
      }
      default:
        return null;
    }
  }

  #withFolder(s: string): string {
    const folder = this.folder();
    return clip(folder ? `${folder}: ${s}` : s);
  }
}
