import type { AgentEvent, ChangedFile, ChangesResponse, FileDiff } from '@ide/shared';
import { trailingQuestion } from './notify.js';
import { judgeTurn, type SummaryQueryFn } from './turnSummary.js';

/**
 * Tự lưu bản (mục Thay đổi) khi Claude xong một việc đủ lớn:
 *   1. thay đổi đủ lớn — có tạo/xóa file, hoặc sửa từ MIN_CHANGED_LINES dòng (đoạn Word, ô Excel) trở lên;
 *      sửa lắt nhắt thì chưa lưu, để gộp vào lần lưu sau;
 *   2. Claude đã làm trọn yêu cầu, kết thúc ý (Claude Haiku đánh giá) — đang hỏi lại hay dừng giữa chừng thì chưa lưu.
 * Mô tả bản lưu là tóm tắt các yêu cầu từ bản lưu trước.
 */

export const MIN_CHANGED_LINES = 10;
/** File không so được nội dung (PDF…) đã sửa: tính như thay đổi lớn chừng này dòng. */
const UNCOMPARABLE_LINES = MIN_CHANGED_LINES;
const MAX_QUESTIONS = 6;

export interface PendingChanges {
  files: ChangedFile[];
  /** Tổng số dòng (đoạn, ô) thêm + bớt ở các file đã sửa. */
  changedLines: number;
  /** Danh sách file kèm mức thay đổi, đưa cho Claude đánh giá. */
  summary: string;
}

export interface SnapshotsLike {
  status(): Promise<ChangesResponse>;
  diff(path: string): Promise<FileDiff>;
  snapshot(message: string): Promise<boolean>;
}

export async function measureChanges(snapshots: SnapshotsLike): Promise<PendingChanges> {
  const { files } = await snapshots.status();
  let changedLines = 0;
  const lines: string[] = [];
  for (const f of files) {
    if (f.status !== 'modified') {
      lines.push(`${f.status === 'added' ? 'tạo mới' : 'xóa'}: ${f.path}`);
      continue;
    }
    const change = (await snapshots.diff(f.path).catch(() => null))?.change;
    const n = change ? change.additions + change.deletions : UNCOMPARABLE_LINES;
    changedLines += n;
    lines.push(change ? `sửa: ${f.path} (+${change.additions}/-${change.deletions})` : `sửa: ${f.path}`);
  }
  return { files, changedLines, summary: lines.slice(0, 30).join('\n') || '(không có)' };
}

export function isBigEnough(p: PendingChanges): boolean {
  return p.files.some((f) => f.status !== 'modified') || p.changedLines >= MIN_CHANGED_LINES;
}

export class AutoSave {
  /** Tin nhắn của người dùng từ bản lưu trước (gộp các lượt hỏi lại – trả lời của cùng một việc). */
  #questions: string[] = [];
  #answer = '';
  #pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: {
      /** Người dùng bật tự lưu (đọc lại mỗi lần, vì cài đặt dùng chung giữa các cửa sổ). */
      enabled?: () => boolean;
      snapshots: SnapshotsLike;
      claudeBin: string;
      queryFn?: SummaryQueryFn;
      onSaved: () => void;
      onError?: (err: unknown) => void;
    },
  ) {}

  /** Chờ lần tự lưu đang chạy (trước lượt mới, để không lẫn thay đổi của lượt sau). */
  idle(): Promise<void> {
    return this.#pending;
  }

  onEvent(event: AgentEvent) {
    switch (event.kind) {
      case 'user':
        // Lệnh hệ thống (/compact…) không phải yêu cầu công việc.
        if (event.text.trim() && !/^\/compact\b/.test(event.text.trim())) {
          this.#questions = [...this.#questions, event.text.trim()].slice(-MAX_QUESTIONS);
        }
        this.#answer = '';
        return;
      case 'block':
        if (event.block.type === 'text' && event.block.text.trim()) this.#answer = event.block.text;
        return;
      case 'cleared':
        this.#questions = [];
        this.#answer = '';
        return;
      case 'result':
        // Bấm dừng hoặc lỗi: việc chưa xong, giữ thay đổi để lưu cùng lần sau.
        if (event.interrupted || event.isError) return;
        this.#pending = this.#pending.then(() => this.#maybeSave()).catch((err) => this.opts.onError?.(err));
        return;
      default:
        return;
    }
  }

  async #maybeSave() {
    if (this.#questions.length === 0 || this.opts.enabled?.() === false) return;
    const pending = await measureChanges(this.opts.snapshots);
    // Chỉ hỏi đáp, không đổi file, và không đang hỏi lại: xong chuyện, không gộp các câu này vào việc sau.
    if (pending.files.length === 0 && !trailingQuestion(this.#answer)) this.#questions = [];
    if (!isBigEnough(pending)) return;
    const verdict = await judgeTurn(
      { questions: this.#questions, answer: this.#answer, changes: pending.summary },
      this.opts.claudeBin,
      this.opts.queryFn,
    );
    if (!verdict.done) return;
    if (await this.opts.snapshots.snapshot(verdict.title)) {
      this.#questions = [];
      this.opts.onSaved();
    }
  }
}
