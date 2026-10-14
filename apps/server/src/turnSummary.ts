import { tmpdir } from 'node:os';
import { query as sdkQuery, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { cliEnv } from './claude-auth.js';
import { trailingQuestion } from './notify.js';

/**
 * Đánh giá một lượt Claude trước khi tự lưu: đã làm trọn yêu cầu, kết thúc ý chưa (không dừng giữa chừng,
 * không đang hỏi lại để làm tiếp) — và đặt mô tả bản lưu là tóm tắt yêu cầu.
 */

const MAX_TITLE = 90;
const MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 25_000;

export type SummaryQueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface TurnVerdict {
  /** Claude đã làm xong yêu cầu, kết thúc ý. */
  done: boolean;
  /** Tóm tắt yêu cầu, làm mô tả bản lưu. */
  title: string;
}

function clip(s: string, max = MAX_TITLE): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Mô tả dự phòng: dòng (câu) đầu của yêu cầu, cắt ngắn. */
export function fallbackTitle(text: string): string {
  const firstLine = text.trim().split('\n').find((l) => l.trim()) ?? '';
  const firstSentence = firstLine.split(/(?<=[.?!])\s+/)[0] ?? firstLine;
  return clip(firstSentence.replace(/\s+/g, ' ').trim() || 'Claude làm việc');
}

/** Làm sạch tiêu đề thành một dòng. */
export function cleanTitle(raw: string): string {
  const line = raw.trim().split('\n').find((l) => l.trim()) ?? '';
  return clip(
    line
      .replace(/^(tiêu đề|title)\s*:\s*/i, '')
      .replace(/^[#*\-\s"“'`]+|["”'`*\s.]+$/g, '')
      .trim(),
  );
}

/** Đọc câu trả lời dạng {"xong": …, "tieu_de": …} của Claude; null nếu không đọc được. */
export function parseVerdict(raw: string): TurnVerdict | null {
  const json = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { xong?: unknown; tieu_de?: unknown };
    if (typeof v.xong !== 'boolean') return null;
    return { done: v.xong, title: typeof v.tieu_de === 'string' ? cleanTitle(v.tieu_de) : '' };
  } catch {
    return null;
  }
}

/** Không hỏi được Claude: coi là chưa xong nếu câu trả lời kết thúc bằng câu hỏi. */
export function fallbackVerdict(questions: string[], answer: string): TurnVerdict {
  return { done: !trailingQuestion(answer), title: fallbackTitle(questions[0] ?? '') };
}

/**
 * Hỏi Claude Haiku (không công cụ, không lưu phiên, không đọc cài đặt hay thư mục làm việc).
 * `questions`: tin nhắn của người dùng từ bản lưu trước (cũ → mới); `answer`: câu trả lời cuối của Claude;
 * `changes`: danh sách file đã đổi.
 */
export async function judgeTurn(
  input: { questions: string[]; answer: string; changes: string },
  claudeBin: string,
  queryFn: SummaryQueryFn = sdkQuery as unknown as SummaryQueryFn,
): Promise<TurnVerdict> {
  const questions = input.questions.slice(-6);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const prompt = [
      'Bạn kiểm tra một lượt làm việc của trợ lý AI trong app đọc và soạn tài liệu, để quyết định có lưu lại thành một mốc thay đổi không.',
      '',
      '<yeu_cau_nguoi_dung> (các tin nhắn, cũ đến mới)',
      ...questions.map((q, i) => `${i + 1}. ${q.slice(0, 1500)}`),
      '</yeu_cau_nguoi_dung>',
      '<tra_loi_cuoi_cua_tro_ly>',
      input.answer.slice(-3000) || '(không có chữ)',
      '</tra_loi_cuoi_cua_tro_ly>',
      '<file_da_doi>',
      input.changes,
      '</file_da_doi>',
      '',
      'Trả lời DUY NHẤT một dòng JSON: {"xong": true hoặc false, "tieu_de": "..."}',
      '- xong = true khi trợ lý đã làm trọn yêu cầu và kết thúc ý: đã có kết quả cuối cùng, câu trả lời đầy đủ ý.',
      '- xong = false khi trợ lý đang hỏi lại hoặc xin xác nhận để làm tiếp, mới làm một phần, dừng vì lỗi, hoặc nói sẽ làm tiếp phần còn lại.',
      '- Đã làm xong rồi mới gợi ý thêm ở cuối (ví dụ "Bạn có muốn tôi xuất Word không?") thì vẫn là xong.',
      '- tieu_de: tóm tắt việc người dùng yêu cầu đã được làm (tối đa 12 từ, cùng ngôn ngữ với người dùng, không ngoặc kép, không chấm cuối).',
    ].join('\n');
    const messages = queryFn({
      prompt,
      options: {
        model: MODEL,
        maxTurns: 1,
        tools: [],
        settingSources: [],
        persistSession: false,
        cwd: tmpdir(),
        env: cliEnv(),
        pathToClaudeCodeExecutable: claudeBin,
        abortController: abort,
      },
    });
    let answer = '';
    for await (const m of messages) {
      if (m.type === 'result' && m.subtype === 'success') answer = m.result;
      else if (m.type === 'assistant' && !answer) {
        const content = (m.message as { content?: { type: string; text?: string }[] }).content ?? [];
        answer = content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
      }
    }
    const verdict = parseVerdict(answer) ?? fallbackVerdict(questions, input.answer);
    return { done: verdict.done, title: verdict.title || fallbackTitle(questions[0] ?? '') };
  } catch {
    return fallbackVerdict(questions, input.answer);
  } finally {
    clearTimeout(timer);
  }
}
