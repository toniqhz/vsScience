import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeProfileInfo } from '@ide/shared';

/**
 * Hồ sơ Claude dựng sẵn (một thư mục theo cấu trúc project Claude Code):
 *   CLAUDE.md                     → quy trình làm việc chung, ghép vào system prompt
 *   .claude/output-styles/*.md    → giọng trả lời, ghép vào system prompt
 *   .claude/agents/*.md           → subagent, đăng ký qua tùy chọn `agents` của SDK
 * Đọc lại mỗi khi bắt đầu phiên Claude, nên sửa file là có hiệu lực ở phiên sau.
 */
export interface ClaudeProfile {
  info: ClaudeProfileInfo;
  systemAppend: string;
  agents: Record<string, AgentDefinition>;
}

/**
 * Hồ sơ được viết cho project Claude Code thông thường (có git, có cấu trúc thư mục phân tích
 * dữ liệu). Phần này điều chỉnh cho app: đặt sau cùng để được ưu tiên.
 */
const APP_ADJUSTMENTS = `# Điều chỉnh khi chạy trong app VsScience (ưu tiên hơn các mục ở trên)

- Không dùng git trong thư mục làm việc: không chạy git init, git add hay git commit. App tự lưu một bản trước mỗi lượt của bạn. Thay cho mục "Git": sau mỗi kết quả quan trọng, nhắc người dùng bấm "Lưu bản" ở mục Thay đổi (thanh bên trái) kèm một dòng mô tả gợi ý.
- Cấu trúc thư mục (data/raw, data/processed, analysis, figures, reports) chỉ áp dụng khi thư mục làm việc đã có cấu trúc đó, hoặc người dùng muốn lập một project phân tích dữ liệu. Với thư mục sách, bài báo, đề thi thông thường: không tự tạo các thư mục này; script phụ để xử lý file đặt ở scratchpad.
- Mục "Bối cảnh project" ở trên là mẫu để trống. Nếu thư mục làm việc có CLAUDE.md riêng thì dùng bối cảnh trong đó; nếu không, hỏi người dùng khi bối cảnh ảnh hưởng tới kết luận.
- Với việc đơn giản như tóm tắt, soạn câu hỏi, sửa đề thì không cần nêu giả thuyết hay gọi phản biện. Quy trình lập luận khoa học và subagent phản biện áp dụng cho phân tích có số liệu, kiểm định, mô hình hay kết luận khoa học.`;

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Đọc frontmatter YAML đơn giản (key: value) ở đầu file Markdown. */
export function parseFrontmatter(src: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) data[kv[1]!] = kv[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { data, body: src.slice(m[0].length) };
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function markdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Bỏ chú thích HTML (hướng dẫn điền mẫu), không cần đưa vào system prompt. */
function stripComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->\n?/g, '').trim();
}

/** Hạ tiêu đề một cấp để nằm dưới mục cha khi ghép vào system prompt. */
function nest(md: string): string {
  return md.replace(/^(#{1,5}) /gm, '#$1 ');
}

function toList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .filter(Boolean);
  return items.length ? items : undefined;
}

/** Đọc hồ sơ từ thư mục; trả về null nếu không có thư mục hoặc thư mục không có gì dùng được. */
export function loadProfile(dir: string | null): ClaudeProfile | null {
  if (!dir) return null;
  const parts: string[] = [];
  const info: ClaudeProfileInfo = { dir, outputStyle: null, agents: [], hasInstructions: false };

  const style = markdownFiles(path.join(dir, '.claude/output-styles'))[0];
  if (style) {
    const { data, body } = parseFrontmatter(readText(style) ?? '');
    if (body.trim()) {
      info.outputStyle = data.name || path.basename(style, '.md');
      parts.push(`# Giọng trả lời: ${info.outputStyle}\n\n${nest(stripComments(body))}`);
    }
  }

  const instructions = stripComments(readText(path.join(dir, 'CLAUDE.md')) ?? '');
  if (instructions) {
    info.hasInstructions = true;
    parts.push(`# Quy trình làm việc chung\n\n${nest(instructions)}`);
  }

  const agents: Record<string, AgentDefinition> = {};
  for (const file of markdownFiles(path.join(dir, '.claude/agents'))) {
    const { data, body } = parseFrontmatter(readText(file) ?? '');
    const name = data.name || path.basename(file, '.md');
    if (!data.description || !body.trim()) continue;
    const tools = toList(data.tools);
    const disallowedTools = toList(data.disallowedTools);
    // Mỗi việc một mô hình và mức suy nghĩ: phản biện dùng Opus suy nghĩ sâu, kiểm tra trích dẫn dùng Sonnet.
    const effort = EFFORTS.has(data.effort ?? '') ? (data.effort as AgentDefinition['effort']) : undefined;
    agents[name] = {
      description: data.description,
      prompt: body.trim(),
      ...(tools ? { tools } : {}),
      ...(disallowedTools ? { disallowedTools } : {}),
      ...(data.model && data.model !== 'inherit' ? { model: data.model } : {}),
      ...(effort ? { effort } : {}),
    };
    info.agents.push({ name, description: data.description });
  }

  if (!parts.length && !info.agents.length) return null;
  if (parts.length) parts.push(APP_ADJUSTMENTS);
  return { info, systemAppend: parts.join('\n\n'), agents };
}
