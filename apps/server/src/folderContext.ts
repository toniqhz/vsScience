import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FolderContext } from '@ide/shared';

/**
 * Bối cảnh thư mục làm việc: một mục trong CLAUDE.md của thư mục (Claude Code đọc file này khi bắt đầu phiên),
 * nằm giữa hai dấu mốc để sửa lại được mà không đụng phần người dùng tự viết.
 */
const START = '<!-- vsscience:boi-canh';
const END = '<!-- /vsscience:boi-canh -->';

export const EMPTY_CONTEXT: FolderContext = { topic: '', audience: '', purpose: '', level: '', citationStyle: '', language: '', notes: '' };

const LABELS: [keyof FolderContext, string][] = [
  ['topic', 'Chủ đề / môn học'],
  ['audience', 'Người đọc'],
  ['purpose', 'Mục đích'],
  ['level', 'Mức độ học thuật'],
  ['citationStyle', 'Chuẩn trích dẫn'],
  ['language', 'Ngôn ngữ viết'],
  ['notes', 'Yêu cầu khác'],
];

const file = (root: string) => path.join(root, 'CLAUDE.md');

function sectionRange(src: string): [number, number] | null {
  const a = src.indexOf(START);
  if (a < 0) return null;
  const b = src.indexOf(END, a);
  return b < 0 ? null : [a, b + END.length];
}

export async function readFolderContext(root: string): Promise<FolderContext> {
  const src = await readFile(file(root), 'utf8').catch(() => '');
  const r = sectionRange(src);
  if (!r) return { ...EMPTY_CONTEXT };
  const json = /^<!-- vsscience:boi-canh (\{.*?\}) -->/s.exec(src.slice(r[0], r[1]))?.[1];
  try {
    return { ...EMPTY_CONTEXT, ...(json ? (JSON.parse(json) as Partial<FolderContext>) : {}) };
  } catch {
    return { ...EMPTY_CONTEXT };
  }
}

export function renderSection(ctx: FolderContext): string {
  const clean = Object.fromEntries(Object.entries(ctx).map(([k, v]) => [k, String(v ?? '').trim().slice(0, 2000)])) as unknown as FolderContext;
  const lines = LABELS.filter(([k]) => clean[k]).map(([k, label]) =>
    clean[k].includes('\n') ? `- ${label}:\n${clean[k].split('\n').map((l) => `  ${l}`).join('\n')}` : `- ${label}: ${clean[k]}`,
  );
  // JSON trong chú thích để app đọc lại form; "--" không được có trong chú thích HTML.
  const json = JSON.stringify(clean).replace(/--/g, '\\u002d\\u002d');
  return [
    `${START} ${json} -->`,
    '# Bối cảnh thư mục (điền trong app VsScience)',
    '',
    'Viết, tóm tắt, đánh giá trong thư mục này theo bối cảnh sau (ưu tiên hơn mặc định chung):',
    '',
    ...lines,
    END,
  ].join('\n');
}

/** Ghi bối cảnh vào CLAUDE.md (tạo file nếu chưa có; giữ nguyên phần còn lại). Bối cảnh rỗng thì bỏ mục. */
export async function writeFolderContext(root: string, ctx: FolderContext): Promise<void> {
  const src = await readFile(file(root), 'utf8').catch(() => '');
  const empty = Object.values(ctx).every((v) => !String(v ?? '').trim());
  const section = empty ? '' : renderSection(ctx);
  const r = sectionRange(src);
  let next: string;
  if (r) next = src.slice(0, r[0]) + section + src.slice(r[1]);
  else next = section ? (src.trim() ? `${section}\n\n${src}` : `${section}\n`) : src;
  next = next.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
  if (next !== src) await writeFile(file(root), next);
}
