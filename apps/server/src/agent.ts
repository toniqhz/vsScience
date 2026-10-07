import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  deleteSession as sdkDeleteSession,
  getSessionMessages as sdkGetSessionMessages,
  listSessions as sdkListSessions,
  query as sdkQuery,
  renameSession as sdkRenameSession,
  type CanUseTool,
  type EffortLevel,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKSessionInfo,
  type SDKUserMessage,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentBlock, AgentEvent, AgentMode, AgentSessionInfo, ContextUsage, FileChange } from '@ide/shared';
import { cliEnv } from './claude-auth.js';
import { FolderGuard, claudeScratchRoot, displayOutside } from './folderGuard.js';
import type { ClaudeProfile } from './profile.js';

/** Phần của Query (Agent SDK) mà phiên dùng tới — tách ra để test bằng phiên giả. */
export interface AgentQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  getContextUsage(): Promise<{ totalTokens: number; maxTokens: number; percentage: number; categories: { name: string; tokens: number; kind: string }[] }>;
  close(): void;
}

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AgentQuery;

/** API quản lý phiên đã lưu của Agent SDK (tách ra để test). */
export interface SessionApi {
  list(dir: string): Promise<SDKSessionInfo[]>;
  messages(id: string, dir: string): Promise<SessionMessage[]>;
  rename(id: string, title: string, dir: string): Promise<void>;
  remove(id: string, dir: string): Promise<void>;
}

const sdkSessions: SessionApi = {
  list: (dir) => sdkListSessions({ dir, includeProgrammatic: true, limit: 200 }),
  messages: (id, dir) => sdkGetSessionMessages(id, { dir }),
  rename: (id, title, dir) => sdkRenameSession(id, title, { dir }),
  remove: (id, dir) => sdkDeleteSession(id, { dir }),
};

const FILES_MARKER = '\n\nFile liên quan (đường dẫn trong thư mục làm việc):\n';

/** Tách lời nhắn người dùng và danh sách file đính kèm mà app đã ghép vào prompt. */
function splitPrompt(prompt: string): { text: string; files: string[] } {
  const i = prompt.indexOf(FILES_MARKER);
  if (i < 0) return { text: prompt, files: [] };
  const files = prompt
    .slice(i + FILES_MARKER.length)
    .split('\n')
    .map((l) => l.replace(/^- /, '').trim())
    .filter(Boolean);
  return { text: prompt.slice(0, i), files };
}

export interface AgentSettings {
  model: string;
  effort: EffortLevel | null;
  mode: AgentMode;
}

const MODE_TO_PERMISSION: Record<AgentMode, PermissionMode> = {
  ask: 'default',
  auto: 'acceptEdits',
  plan: 'plan',
};

/** Hướng dẫn thêm vào system prompt của Claude Code cho người dùng không làm kỹ thuật. */
const SYSTEM_APPEND = `Người dùng là người đọc sách, đọc báo khoa học và soạn đề thi — không phải lập trình viên.
- Luôn trả lời bằng tiếng Việt, ngắn gọn, dễ hiểu.
- Không đưa mã nguồn hay câu lệnh vào câu trả lời trừ khi người dùng hỏi. Khi cần chạy lệnh hay script để xử lý file, cứ làm rồi chỉ báo kết quả.
- Khi trích dẫn tài liệu PDF, ghi rõ số trang.
- Thư mục làm việc chứa tài liệu PDF, Word, Excel của người dùng. Không để file tạm hay file rác trong đó; script và file tạm đặt trong thư mục scratchpad của bạn.
- Chỉ đọc, sửa, chạy lệnh với file trong thư mục làm việc và scratchpad. Nếu thật sự cần file ở ngoài, nói rõ với người dùng cần file nào và vì sao; người dùng sẽ được hỏi cho phép.`;

const OUTPUT_LIMIT = 4000;
/** Báo cáo của trợ lý phụ (ví dụ phản biện) được hiện dạng văn bản nên giữ dài hơn. */
const AGENT_OUTPUT_LIMIT = 30000;

/**
 * Kết quả của subagent gồm khung ghi chú nội bộ, báo cáo thụt lề 2 dấu cách, rồi dòng agentId và
 * thẻ <usage>. Chỉ giữ báo cáo để hiện cho người dùng.
 */
export function cleanAgentReport(text: string): string {
  const marker = 'The report follows:\n';
  const start = text.indexOf(marker);
  if (start < 0 || !text.startsWith('[Subagent hand-back]')) return text;
  let body = text.slice(start + marker.length);
  body = body.replace(/\n?<usage>[\s\S]*?<\/usage>\s*$/, '').replace(/\n?agentId: [^\n]*\s*$/, '');
  return body
    .split('\n')
    .map((l) => l.replace(/^ {2}/, ''))
    .join('\n')
    .trim();
}

const ERROR_TEXT: Record<string, string> = {
  authentication_failed: 'Chưa đăng nhập Claude hoặc phiên đăng nhập đã hết hạn. Gõ /login để đăng nhập lại.',
  oauth_org_not_allowed: 'Tài khoản Claude này không được phép dùng ở đây.',
  account_on_hold: 'Tài khoản Claude đang bị tạm khóa.',
  verification_required: 'Tài khoản Claude cần xác minh. Hãy mở claude.ai để hoàn tất.',
  billing_error: 'Có vấn đề với thanh toán của tài khoản Claude.',
  rate_limit: 'Đã chạm giới hạn sử dụng của gói Claude. Hãy thử lại sau.',
  overloaded: 'Claude đang quá tải. Hãy thử lại sau ít phút.',
  model_not_found: 'Không dùng được model này với tài khoản hiện tại. Hãy chọn model khác.',
  max_output_tokens: 'Câu trả lời quá dài nên bị cắt.',
};

/** Hàng đợi tin nhắn người dùng, làm đầu vào dạng stream cho query() để giữ phiên sống giữa các lượt. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #wake: (() => void) | null = null;
  #ended = false;

  push(item: SDKUserMessage) {
    this.#items.push(item);
    this.#wake?.();
  }

  end() {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const item = this.#items.shift();
      if (item) {
        yield item;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((r) => (this.#wake = r));
      this.#wake = null;
    }
  }
}

function countLines(lines: string[]) {
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    if (l.startsWith('+')) additions++;
    else if (l.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

const CONTEXT_LINES = 2;

/**
 * Diff theo dòng giữa hai đoạn văn bản: bỏ các dòng giống nhau ở đầu và cuối
 * (giữ vài dòng làm ngữ cảnh), phần ở giữa coi là bỏ/thêm. Đủ cho bản xem trước.
 */
function lineDiff(oldText: string, newText: string, startLine: number) {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ctxBefore = a.slice(Math.max(0, pre - CONTEXT_LINES), pre);
  const ctxAfter = a.slice(a.length - suf, a.length - suf + CONTEXT_LINES);
  const lines = [
    ...ctxBefore.map((l) => ` ${l}`),
    ...a.slice(pre, a.length - suf).map((l) => `-${l}`),
    ...b.slice(pre, b.length - suf).map((l) => `+${l}`),
    ...ctxAfter.map((l) => ` ${l}`),
  ];
  const first = startLine + pre - ctxBefore.length;
  return { oldStart: first, newStart: first, lines };
}

/** Bản xem trước thay đổi khi xin quyền sửa (trước khi công cụ chạy). */
function previewChange(toolName: string, input: Record<string, unknown>, rel: (p: string) => string): FileChange | undefined {
  const file = typeof input.file_path === 'string' ? input.file_path : null;
  if (!file) return undefined;
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  let hunk: { oldStart: number; newStart: number; lines: string[] };
  let kind: FileChange['kind'] = 'edit';
  if (toolName === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const at = current?.indexOf(input.old_string) ?? -1;
    const line = at >= 0 ? current!.slice(0, at).split('\n').length : 0;
    hunk = lineDiff(input.old_string, input.new_string, line);
  } else if (toolName === 'Write' && typeof input.content === 'string') {
    if (current === null) kind = 'create';
    hunk = lineDiff(current ?? '', input.content, 1);
  } else {
    return undefined;
  }
  return { path: rel(file), kind, ...countLines(hunk.lines), hunks: [hunk] };
}

/** Đường dẫn file trong input của công cụ đổi sang tương đối để hiển thị. */
function displayInput(input: Record<string, unknown>, rel: (p: string) => string): Record<string, unknown> {
  const out = { ...input };
  for (const key of ['file_path', 'notebook_path', 'path']) {
    if (typeof out[key] === 'string') out[key] = rel(out[key]);
  }
  return out;
}

/**
 * Thay đổi file dựng từ input của công cụ, khi không có `tool_use_result`
 * (ví dụ khi mở lại phiên cũ từ lịch sử).
 */
function changeFromInput(
  tool: { name: string; input: Record<string, unknown> } | undefined,
  output: string,
  rel: (p: string) => string,
): FileChange | undefined {
  if (!tool || typeof tool.input.file_path !== 'string') return undefined;
  let hunk;
  let kind: FileChange['kind'] = 'edit';
  if (tool.name === 'Edit' && typeof tool.input.old_string === 'string' && typeof tool.input.new_string === 'string') {
    hunk = lineDiff(tool.input.old_string, tool.input.new_string, 0);
  } else if (tool.name === 'Write' && typeof tool.input.content === 'string') {
    if (/created/i.test(output)) kind = 'create';
    hunk = lineDiff('', tool.input.content, 0);
  } else {
    return undefined;
  }
  return { path: rel(tool.input.file_path), kind, ...countLines(hunk.lines), hunks: [hunk] };
}

/** Thay đổi file thật sau khi Edit/Write chạy xong (từ `tool_use_result`). */
function changeFromResult(result: unknown, rel: (p: string) => string): FileChange | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as { filePath?: unknown; structuredPatch?: unknown; type?: unknown; originalFile?: unknown };
  if (typeof r.filePath !== 'string' || !Array.isArray(r.structuredPatch)) return undefined;
  const hunks = (r.structuredPatch as { oldStart: number; newStart: number; lines: string[] }[]).map((h) => ({
    oldStart: h.oldStart,
    newStart: h.newStart,
    lines: h.lines,
  }));
  let lines = hunks.flatMap((h) => h.lines);
  // Write tạo file mới: structuredPatch rỗng, lấy nội dung file làm toàn bộ dòng thêm.
  if (r.type === 'create' && lines.length === 0 && typeof (result as { content?: unknown }).content === 'string') {
    lines = ((result as { content: string }).content.split('\n')).map((l) => `+${l}`);
    hunks.push({ oldStart: 0, newStart: 1, lines });
  }
  return { path: rel(r.filePath), kind: r.type === 'create' ? 'create' : 'edit', ...countLines(lines), hunks };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? (c as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Vị trí khối trong tin nhắn đang stream, để khối hoàn chỉnh thay đúng chỗ chữ stream dở. */
interface MessageState {
  text: number[];
  thinking: number[];
  tools: Map<string, number>;
  seen: Set<string>;
  next: number;
}

/**
 * Một phiên trợ lý dùng Claude Agent SDK (Claude Code chạy như thư viện), với phiên
 * đăng nhập Claude.ai trên máy. Mỗi thư mục làm việc một phiên; đổi thư mục thì xóa phiên.
 */
export class AgentSession {
  #log: AgentEvent[] = [];
  #query: AgentQuery | null = null;
  #input: InputQueue | null = null;
  #sessionId: string | null = null;
  #applied: AgentSettings | null = null;
  #cwd: string | null = null;
  #running = false;
  #messages = new Map<string, MessageState>();
  #streamingMessageId: string | null = null;
  #pending = new Map<string, { resolve: (r: PermissionResult) => void; input: Record<string, unknown>; suggestions?: PermissionUpdate[] }>();
  #stderr: string[] = [];
  /** Người dùng vừa bấm dừng: kết quả lỗi của lượt này là do dừng, không phải lỗi thật. */
  #interrupted = false;
  /** Input gốc của các công cụ đã gọi, để dựng thẻ thay đổi file khi thiếu kết quả chi tiết. */
  #toolInputs = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** Đang dựng lại hội thoại từ lịch sử: chỉ ghi nhật ký, không gửi từng sự kiện. */
  #replaying = false;

  constructor(
    private readonly opts: {
      cwd: () => string;
      claudeBin: string;
      emit: (event: AgentEvent) => void;
      /** Gửi lại toàn bộ hội thoại (khi mở một phiên cũ). */
      replay?: (events: AgentEvent[]) => void;
      /** Danh sách phiên đã đổi. */
      onSessionsChanged?: () => void;
      /** Chạy trước mỗi lượt Claude (ví dụ tự lưu bản). Lỗi ở đây không chặn lượt. */
      beforeTurn?: (text: string) => Promise<void>;
      /** Hồ sơ Claude dựng sẵn, đọc lại mỗi khi bắt đầu phiên. */
      profile?: () => ClaudeProfile | null;
      queryFn?: QueryFn;
      sessions?: SessionApi;
    },
  ) {}

  get #sessions(): SessionApi {
    return this.opts.sessions ?? sdkSessions;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  events(): AgentEvent[] {
    return this.#log;
  }

  get running(): boolean {
    return this.#running;
  }

  #emit(event: AgentEvent) {
    if (event.kind === 'block') {
      // Chữ stream dở của khối này không cần giữ trong nhật ký nữa.
      this.#log = this.#log.filter(
        (e) => !(e.kind === 'delta' && e.messageId === event.messageId && e.index === event.index),
      );
    }
    this.#log.push(event);
    if (!this.#replaying) this.opts.emit(event);
  }

  #rel = (p: string) => {
    const cwd = this.#cwd ?? this.opts.cwd();
    const r = path.relative(cwd, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p;
  };

  async send(text: string, files: string[], settings: AgentSettings) {
    const cwd = this.opts.cwd();
    const needsRestart =
      !this.#query || this.#cwd !== cwd || this.#applied?.effort !== settings.effort;
    if (needsRestart) {
      await this.#stop();
      this.#start(settings, cwd);
    } else if (this.#query && this.#applied) {
      if (this.#applied.model !== settings.model) await this.#query.setModel(settings.model);
      if (this.#applied.mode !== settings.mode) await this.#query.setPermissionMode(MODE_TO_PERMISSION[settings.mode]);
      this.#applied = settings;
    }

    await this.opts.beforeTurn?.(text).catch(() => {});
    const prompt = files.length ? `${text}${FILES_MARKER}${files.map((f) => `- ${f}`).join('\n')}` : text;
    this.#emit({ kind: 'user', id: randomUUID(), text, files });
    this.#setRunning(true);
    this.#input?.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
  }

  async interrupt() {
    if (!this.#query || !this.#running) return;
    this.#interrupted = true;
    this.#denyAllPending();
    await this.#query.interrupt().catch(() => {});
  }

  respondPermission(id: string, allow: boolean, always = false) {
    const p = this.#pending.get(id);
    if (!p) return false;
    this.#pending.delete(id);
    p.resolve(
      allow
        ? { behavior: 'allow', updatedInput: p.input, updatedPermissions: always ? p.suggestions : undefined }
        : { behavior: 'deny', message: 'Người dùng không cho phép thao tác này.' },
    );
    this.#emit({ kind: 'permission-resolved', id, allowed: allow });
    return true;
  }

  async contextUsage(): Promise<ContextUsage | null> {
    if (!this.#query) return null;
    try {
      const u = await this.#query.getContextUsage();
      return {
        used: u.totalTokens,
        max: u.maxTokens,
        percentage: u.percentage,
        categories: u.categories.filter((c) => c.kind === 'used' && c.tokens > 0).map((c) => ({ name: c.name, tokens: c.tokens })),
      };
    } catch {
      return null;
    }
  }

  /** Xóa hội thoại và kết thúc phiên (lượt sau bắt đầu phiên mới). */
  async clear() {
    await this.#stop();
    this.#sessionId = null;
    this.#log = [];
    this.#messages.clear();
    this.#toolInputs.clear();
    this.opts.emit({ kind: 'cleared' });
    this.opts.onSessionsChanged?.();
  }

  async listSessions(): Promise<AgentSessionInfo[]> {
    const cwd = this.opts.cwd();
    const list = await this.#sessions.list(cwd);
    return list
      .filter((s) => !s.cwd || s.cwd === cwd)
      .sort((a, b) => b.lastModified - a.lastModified)
      .map((s) => ({
        id: s.sessionId,
        title: (s.customTitle || splitPrompt(s.firstPrompt ?? '').text || s.summary || 'Hội thoại').trim().slice(0, 120),
        lastModified: s.lastModified,
        current: s.sessionId === this.#sessionId,
      }));
  }

  /** Mở lại một phiên đã lưu: dựng lại hội thoại; tin nhắn sau sẽ tiếp tục phiên đó. */
  async openSession(id: string) {
    const cwd = this.opts.cwd();
    const messages = await this.#sessions.messages(id, cwd);
    await this.#stop();
    this.#sessionId = id;
    this.#cwd = cwd;
    this.#log = [];
    this.#messages.clear();
    this.#toolInputs.clear();
    this.#replaying = true;
    try {
      let turnOpen = false;
      for (const sm of messages) {
        if (sm.parent_tool_use_id) continue;
        const msg = sm.message as { role?: string; content?: unknown };
        if (sm.type === 'user') {
          const content = msg.content;
          const isToolResult = Array.isArray(content) && content.some((c) => (c as { type?: string }).type === 'tool_result');
          if (isToolResult) {
            await this.#handle({ type: 'user', message: msg, parent_tool_use_id: null } as SDKMessage);
            continue;
          }
          const raw =
            typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content.map((c) => ((c as { type?: string }).type === 'text' ? (c as { text: string }).text : '')).join('')
                : '';
          // Bỏ nội dung hệ thống chèn vào (lệnh, ngắt lượt…), chỉ giữ lời nhắn thật.
          if (!raw.trim() || raw.startsWith('<') || raw.startsWith('[Request interrupted')) continue;
          if (turnOpen) this.#emit({ kind: 'result', isError: false, durationMs: 0 });
          const { text, files } = splitPrompt(raw);
          this.#emit({ kind: 'user', id: sm.uuid, text, files });
          turnOpen = true;
        } else if (sm.type === 'assistant') {
          await this.#handle({ type: 'assistant', message: sm.message, parent_tool_use_id: null } as SDKMessage);
        }
      }
      if (turnOpen) this.#emit({ kind: 'result', isError: false, durationMs: 0 });
    } finally {
      this.#replaying = false;
      this.#messages.clear();
    }
    this.opts.replay?.(this.#log);
    this.opts.onSessionsChanged?.();
  }

  async renameSession(id: string, title: string) {
    await this.#sessions.rename(id, title, this.opts.cwd());
    this.opts.onSessionsChanged?.();
  }

  async deleteSession(id: string) {
    if (id === this.#sessionId) await this.clear();
    await this.#sessions.remove(id, this.opts.cwd());
    this.opts.onSessionsChanged?.();
  }

  async close() {
    await this.#stop();
  }

  #setRunning(running: boolean) {
    if (this.#running === running) return;
    this.#running = running;
    this.#emit({ kind: 'status', state: running ? 'running' : 'idle' });
  }

  #start(settings: AgentSettings, cwd: string) {
    const input = new InputQueue();
    // Phạm vi tự do: thư mục làm việc + thư mục scratchpad mà Claude Code cấp cho mỗi phiên.
    const guard = new FolderGuard(() => [cwd, claudeScratchRoot(cwd)]);
    const canUseTool: CanUseTool = (toolName, toolInput, { signal, suggestions }) =>
      new Promise<PermissionResult>((resolve) => {
        const outside = FolderGuard.touchesFiles(toolName) ? guard.outside(toolName, toolInput, cwd) : [];
        // Chế độ "Tự động": tự cho chạy lệnh và sửa file, miễn là chỉ trong thư mục làm việc (và thư mục nháp).
        // Kế hoạch (ExitPlanMode) luôn cần người dùng duyệt.
        if (this.#applied?.mode === 'auto' && outside.length === 0 && toolName !== 'ExitPlanMode') {
          resolve({ behavior: 'allow', updatedInput: toolInput });
          return;
        }
        const id = randomUUID();
        this.#pending.set(id, { resolve, input: toolInput, suggestions });
        signal.addEventListener('abort', () => {
          if (this.#pending.delete(id)) {
            resolve({ behavior: 'deny', message: 'Đã dừng.' });
            this.#emit({ kind: 'permission-resolved', id, allowed: false });
          }
        });
        this.#emit({
          kind: 'permission',
          id,
          toolName,
          input: displayInput(toolInput, this.#rel),
          fileChange: previewChange(toolName, toolInput, this.#rel),
          ...(outside.length ? { outside: outside.map(displayOutside) } : {}),
        });
      });

    const profile = this.opts.profile?.() ?? null;
    const options: Options = {
      cwd,
      model: settings.model,
      ...(settings.effort ? { effort: settings.effort } : {}),
      permissionMode: MODE_TO_PERMISSION[settings.mode],
      canUseTool,
      includePartialMessages: true,
      pathToClaudeCodeExecutable: this.opts.claudeBin,
      env: cliEnv({
        CLAUDE_AGENT_SDK_CLIENT_APP: 'ban-lam-viec/0.1',
        // App chưa có giao diện cho tác vụ nền: subagent (ví dụ phản biện) và lệnh dài phải chạy xong
        // trong lượt, để Claude có kết quả trước khi trả lời và không xin quyền sau khi lượt đã kết thúc.
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      }),
      settingSources: ['user', 'project', 'local'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: [SYSTEM_APPEND, profile?.systemAppend].filter(Boolean).join('\n\n'),
      },
      ...(profile && Object.keys(profile.agents).length ? { agents: profile.agents } : {}),
      // Câu hỏi nhiều lựa chọn cần giao diện riêng — chưa hỗ trợ.
      disallowedTools: ['AskUserQuestion'],
      stderr: (data) => {
        this.#stderr.push(data);
        if (this.#stderr.length > 20) this.#stderr.shift();
      },
      ...(this.#sessionId ? { resume: this.#sessionId } : {}),
    };

    const q = (this.opts.queryFn ?? (sdkQuery as unknown as QueryFn))({ prompt: input, options });
    this.#query = q;
    this.#input = input;
    this.#applied = settings;
    this.#cwd = cwd;
    void this.#pump(q);
  }

  async #pump(q: AgentQuery) {
    try {
      for await (const m of q) {
        if (this.#query !== q) break;
        await this.#handle(m);
      }
    } catch (err) {
      if (this.#query === q) {
        const detail = this.#stderr.join('').trim().split('\n').pop();
        this.#emit({ kind: 'error', message: `Trợ lý bị lỗi: ${(err as Error).message}${detail ? ` (${detail})` : ''}` });
      }
    } finally {
      if (this.#query === q) {
        this.#query = null;
        this.#input = null;
        this.#denyAllPending();
        this.#setRunning(false);
      }
    }
  }

  async #stop() {
    const q = this.#query;
    this.#query = null;
    this.#input?.end();
    this.#input = null;
    this.#denyAllPending();
    q?.close();
    this.#setRunning(false);
  }

  #denyAllPending() {
    for (const [id, p] of this.#pending) {
      p.resolve({ behavior: 'deny', message: 'Đã dừng.' });
      this.#emit({ kind: 'permission-resolved', id, allowed: false });
    }
    this.#pending.clear();
  }

  #state(messageId: string): MessageState {
    let s = this.#messages.get(messageId);
    if (!s) {
      s = { text: [], thinking: [], tools: new Map(), seen: new Set(), next: 0 };
      this.#messages.set(messageId, s);
    }
    return s;
  }

  async #handle(m: SDKMessage) {
    // Tin nhắn của tác tử con (subagent) không hiện riêng.
    if ('parent_tool_use_id' in m && m.parent_tool_use_id) return;

    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') this.#sessionId = m.session_id;
        return;

      case 'stream_event': {
        const ev = m.event;
        if (ev.type === 'message_start') {
          this.#streamingMessageId = ev.message.id;
        } else if (ev.type === 'content_block_start' && this.#streamingMessageId) {
          const s = this.#state(this.#streamingMessageId);
          const b = ev.content_block;
          if (b.type === 'text') s.text.push(ev.index);
          else if (b.type === 'thinking') s.thinking.push(ev.index);
          else if (b.type === 'tool_use') s.tools.set(b.id, ev.index);
          s.next = Math.max(s.next, ev.index + 1);
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && this.#streamingMessageId) {
          this.#emit({ kind: 'delta', messageId: this.#streamingMessageId, index: ev.index, text: ev.delta.text });
        }
        return;
      }

      case 'assistant': {
        if (m.error) {
          this.#emit({ kind: 'error', message: ERROR_TEXT[m.error] ?? `Claude báo lỗi (${m.error}).` });
        }
        const msg = m.message;
        const s = this.#state(msg.id);
        for (const raw of msg.content) {
          let block: AgentBlock | null = null;
          let sig = '';
          let index: number | undefined;
          if (raw.type === 'text') {
            block = { type: 'text', text: raw.text };
            sig = `t:${raw.text}`;
          } else if (raw.type === 'tool_use') {
            const input = (raw.input ?? {}) as Record<string, unknown>;
            this.#toolInputs.set(raw.id, { name: raw.name, input });
            block = { type: 'tool_use', id: raw.id, name: raw.name, input: displayInput(input, this.#rel) };
            sig = `u:${raw.id}`;
            index = s.tools.get(raw.id);
          } else if (raw.type === 'thinking') {
            block = { type: 'thinking', text: raw.thinking };
            sig = `k:${raw.signature ?? raw.thinking}`;
          }
          if (!block || s.seen.has(sig)) continue;
          s.seen.add(sig);
          if (index === undefined) {
            const queue = block.type === 'text' ? s.text : block.type === 'thinking' ? s.thinking : [];
            index = queue.shift() ?? s.next++;
          }
          s.next = Math.max(s.next, index + 1);
          this.#emit({ kind: 'block', messageId: msg.id, index, block });
        }
        return;
      }

      case 'user': {
        const content = m.message.content;
        if (!Array.isArray(content)) return;
        const results = content.filter((c) => c.type === 'tool_result');
        for (const r of results) {
          if (r.type !== 'tool_result') continue;
          let output = toolResultText(r.content);
          const toolName = this.#toolInputs.get(r.tool_use_id)?.name;
          const isAgent = toolName === 'Agent' || toolName === 'Task';
          if (isAgent) output = cleanAgentReport(output);
          const limit = isAgent ? AGENT_OUTPUT_LIMIT : OUTPUT_LIMIT;
          if (output.length > limit) output = `${output.slice(0, limit)}\n…`;
          const fromResult = results.length === 1 ? changeFromResult(m.tool_use_result, this.#rel) : undefined;
          const fileChange =
            fromResult ?? (r.is_error ? undefined : changeFromInput(this.#toolInputs.get(r.tool_use_id), output, this.#rel));
          this.#emit({ kind: 'tool-result', toolUseId: r.tool_use_id, isError: r.is_error === true, output, fileChange });
        }
        return;
      }

      case 'result': {
        const interrupted = this.#interrupted;
        this.#interrupted = false;
        if (interrupted) {
          this.#emit({ kind: 'result', isError: false, durationMs: m.duration_ms, interrupted: true });
        } else {
          const message = m.is_error ? ('errors' in m && m.errors.length ? m.errors.join('\n') : 'Lượt làm việc bị lỗi.') : undefined;
          this.#emit({ kind: 'result', isError: m.is_error, durationMs: m.duration_ms, message });
        }
        this.#messages.clear();
        this.#setRunning(false);
        this.opts.onSessionsChanged?.();
        const usage = await this.contextUsage();
        if (usage) this.#emit({ kind: 'context', usage });
        return;
      }
    }
  }
}
