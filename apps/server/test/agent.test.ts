import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpServerStatus, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@ide/shared';
import { AgentSession, cleanAgentReport, isTrustedReadOnlyMcpTool, sameDir, toConnectorInfo, type AgentQuery, type QueryFn } from '../src/agent.js';

const CWD = '/tmp/ws-gia';

const MCP_STATUSES: McpServerStatus[] = [
  {
    name: 'claude.ai Consensus',
    status: 'connected',
    source: 'claudeai',
    tools: [
      { name: 'search', description: 'Search papers', annotations: { readOnly: true } },
      { name: 'save_search', annotations: { readOnly: false } },
    ],
  },
  { name: 'claude.ai Scite', status: 'needs-auth', source: 'claudeai' },
  { name: 'du-an', status: 'connected', source: 'project', tools: [{ name: 'search', annotations: { readOnly: true } }] },
];
const SETTINGS = { model: 'claude-opus-5-5', effort: 'medium' as const, mode: 'ask' as const };

type Handler = (user: SDKUserMessage, options: Options) => AsyncGenerator<SDKMessage>;

/** Phiên Agent SDK giả: với mỗi tin nhắn người dùng, phát lại kịch bản tin nhắn của handler. */
function fakeQueryFn(handler: Handler) {
  const created: { options: Options; closed: boolean; models: string[]; modes: string[] }[] = [];
  const fn: QueryFn = ({ prompt, options }) => {
    const rec = { options, closed: false, models: [] as string[], modes: [] as string[] };
    created.push(rec);
    const q: AgentQuery = {
      async *[Symbol.asyncIterator]() {
        for await (const user of prompt) yield* handler(user, options);
      },
      interrupt: async () => undefined,
      setModel: async (m) => void rec.models.push(m ?? ''),
      setPermissionMode: async (m) => void rec.modes.push(m),
      getContextUsage: async () => ({
        totalTokens: 12_000,
        maxTokens: 1_000_000,
        percentage: 1.2,
        categories: [
          { name: 'System prompt', tokens: 3000, kind: 'used' },
          { name: 'Messages', tokens: 9000, kind: 'used' },
          { name: 'Free space', tokens: 988_000, kind: 'free' },
        ],
      }),
      mcpServerStatus: async () => MCP_STATUSES,
      close: () => void (rec.closed = true),
    };
    return q;
  };
  return { fn, created };
}

function setup(handler: Handler) {
  const events: AgentEvent[] = [];
  const fake = fakeQueryFn(handler);
  const session = new AgentSession({ cwd: () => CWD, claudeBin: '/khong/can', emit: (e) => events.push(e), queryFn: fake.fn });
  return { session, events, fake };
}

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
};

const m = (x: object) => x as unknown as SDKMessage;

describe('cleanAgentReport', () => {
  it('chỉ giữ báo cáo của subagent, bỏ khung ghi chú, thụt lề, agentId và usage', () => {
    const raw =
      '[Subagent hand-back] The text below is the final report… The report follows:\n' +
      '  ## PHẢN BIỆN\n  \n  - **Mức độ**: Nghiêm trọng\n    - chi tiết\n' +
      "agentId: abc123 (use SendMessage with to: 'abc123')\n<usage>subagent_tokens: 1\ntool_uses: 5</usage>";
    expect(cleanAgentReport(raw)).toBe('## PHẢN BIỆN\n\n- **Mức độ**: Nghiêm trọng\n  - chi tiết');
    expect(cleanAgentReport('Kết quả thường')).toBe('Kết quả thường');
  });
});

describe('AgentSession', () => {
  it('stream chữ, thay bằng khối hoàn chỉnh, tạo thẻ thay đổi file và báo ngữ cảnh', async () => {
    const { session, events } = setup(async function* () {
      yield m({ type: 'system', subtype: 'init', session_id: 's1' });
      yield m({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg1' } } });
      yield m({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
      yield m({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Tôi sẽ ' } } });
      yield m({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sửa file.' } } });
      yield m({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg1', content: [{ type: 'text', text: 'Tôi sẽ sửa file.' }] } });
      yield m({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'Edit', input: {} } } });
      // Tin nhắn hoàn chỉnh có thể lặp lại khối cũ — không được hiện hai lần.
      yield m({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'msg1',
          content: [
            { type: 'text', text: 'Tôi sẽ sửa file.' },
            { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: `${CWD}/De thi.md`, old_string: 'a', new_string: 'b' } },
          ],
        },
      });
      yield m({
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }] },
        tool_use_result: {
          filePath: `${CWD}/De thi.md`,
          structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' câu 1', '-câu 2 cũ', '+câu 2 mới', '+câu 3'] }],
        },
      });
      // Tin nhắn của tác tử con bị bỏ qua.
      yield m({ type: 'assistant', parent_tool_use_id: 'tu1', message: { id: 'sub', content: [{ type: 'text', text: 'ẩn' }] } });
      yield m({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234 });
    });

    await session.send('Sửa câu 2', ['De thi.md'], SETTINGS);
    await until(() => events.some((e) => e.kind === 'context'));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      'user', 'status', 'delta', 'delta', 'block', 'block', 'tool-result', 'result', 'status', 'context',
    ]);
    const blocks = events.filter((e) => e.kind === 'block');
    expect(blocks.map((b) => [b.index, b.block.type])).toEqual([[0, 'text'], [1, 'tool_use']]);
    const result = events.find((e) => e.kind === 'tool-result');
    expect(result?.kind === 'tool-result' && result.fileChange).toEqual({
      path: 'De thi.md',
      kind: 'edit',
      additions: 2,
      deletions: 1,
      hunks: [{ oldStart: 3, newStart: 3, lines: [' câu 1', '-câu 2 cũ', '+câu 2 mới', '+câu 3'] }],
    });
    const ctx = events.find((e) => e.kind === 'context');
    expect(ctx?.kind === 'context' && ctx.usage).toEqual({
      used: 12_000,
      max: 1_000_000,
      percentage: 1.2,
      categories: [
        { name: 'System prompt', tokens: 3000 },
        { name: 'Messages', tokens: 9000 },
      ],
    });
    // Nhật ký gửi lại cho trình duyệt không giữ chữ stream dở đã có khối hoàn chỉnh.
    expect(session.events().some((e) => e.kind === 'delta')).toBe(false);
  });

  it('chế độ Tự động: tự cho chạy lệnh trong thư mục làm việc, ra ngoài thì hỏi kèm lý do', async () => {
    const decisions: unknown[] = [];
    const ask = (options: Options, command: string) =>
      options.canUseTool!('Bash', { command, description: 'Đọc file' }, { signal: new AbortController().signal, suggestions: [] } as never);
    const { session, events } = setup(async function* (_user, options) {
      decisions.push(await ask(options, `python3 -c "print(open('${CWD}/Đề.docx','rb').read()[:2])"`));
      decisions.push(await ask(options, 'cat /home/ai-do/bi-mat.txt'));
      yield m({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
    });
    await session.send('Đọc đề', [], { ...SETTINGS, mode: 'auto' });
    await until(() => events.some((e) => e.kind === 'permission'));
    // Lệnh đầu chạy luôn, không hỏi; chỉ lệnh thứ hai (ngoài thư mục) hiện thẻ xin quyền.
    expect(decisions[0]).toMatchObject({ behavior: 'allow' });
    const perms = events.filter((e) => e.kind === 'permission');
    expect(perms).toHaveLength(1);
    const perm = perms[0]!;
    if (perm.kind !== 'permission') throw new Error('thiếu yêu cầu xin quyền');
    expect(perm.outside).toEqual(['/home/ai-do/bi-mat.txt']);
    session.respondPermission(perm.id, false);
    await until(() => decisions.length === 2);
    expect(decisions[1]).toMatchObject({ behavior: 'deny' });
    await session.close();
  });

  it('thư mục nháp của app: ghi rõ trong hướng dẫn cho Claude, chạy script trong đó không cần hỏi', async () => {
    const scratchRoot = mkdtempSync(path.join(tmpdir(), 'nhap-app-'));
    const decisions: unknown[] = [];
    let append = '';
    const fake = fakeQueryFn(async function* (_user, options) {
      append = (options.systemPrompt as { append: string }).append;
      const scratch = /thư mục nháp `([^`]+)`/.exec(append)![1]!;
      const ask = (command: string) =>
        options.canUseTool!('Bash', { command }, { signal: new AbortController().signal, suggestions: [] } as never);
      decisions.push(await ask(`python "${scratch}/sua_diem.py" "${CWD}/bang-diem.xlsx"`));
      yield m({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
    });
    const events: AgentEvent[] = [];
    const session = new AgentSession({ cwd: () => CWD, claudeBin: '/khong/can', emit: (e) => events.push(e), queryFn: fake.fn, scratchRoot });
    await session.send('Sửa điểm', [], { ...SETTINGS, mode: 'auto' });
    await until(() => decisions.length === 1);
    expect(append).toContain(`Thư mục làm việc \`${CWD}\``);
    expect(append).toMatch(new RegExp(`thư mục nháp \`${scratchRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[0-9a-f]{12}\``));
    expect(decisions[0]).toMatchObject({ behavior: 'allow' });
    expect(events.some((e) => e.kind === 'permission')).toBe(false);
    await session.close();
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  it('chế độ Hỏi trước: lệnh trong thư mục vẫn hỏi như cũ', async () => {
    const { session, events } = setup(async function* (_user, options) {
      await options.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, suggestions: [] } as never);
      yield m({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
    });
    await session.send('Liệt kê', [], SETTINGS);
    await until(() => events.some((e) => e.kind === 'permission'));
    const perm = events.find((e) => e.kind === 'permission');
    expect(perm?.kind === 'permission' && perm.outside).toBeUndefined();
    await session.close();
  });

  it('chuyển yêu cầu xin quyền lên giao diện, kèm bản xem trước thay đổi', async () => {
    let decision: unknown;
    const { session, events } = setup(async function* (_user, options) {
      decision = await options.canUseTool!('Write', { file_path: `${CWD}/moi.md`, content: 'dòng 1\ndòng 2' }, {
        signal: new AbortController().signal,
        suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      } as never);
      yield m({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
    });
    await session.send('Tạo file', [], SETTINGS);
    await until(() => events.some((e) => e.kind === 'permission'));
    const perm = events.find((e) => e.kind === 'permission');
    if (perm?.kind !== 'permission') throw new Error('thiếu yêu cầu xin quyền');
    expect(perm.fileChange).toMatchObject({ path: 'moi.md', kind: 'create', additions: 2, deletions: 0 });

    expect(session.respondPermission(perm.id, true, true)).toBe(true);
    await until(() => decision !== undefined);
    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: `${CWD}/moi.md`, content: 'dòng 1\ndòng 2' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    expect(events).toContainEqual({ kind: 'permission-resolved', id: perm.id, allowed: true });
    expect(session.respondPermission(perm.id, true)).toBe(false);
  });

  it('bản xem trước khi sửa: đúng số dòng trong file, chỉ hiện phần thực sự đổi', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-preview-'));
    const file = path.join(dir, 'de.md');
    writeFileSync(file, ['# Đề', '', 'Câu 1: A', 'Câu 2: B', 'Câu 3: C', 'Câu 4: D'].join('\n'));
    const events: AgentEvent[] = [];
    const fake = fakeQueryFn(async function* (_u, options) {
      await options.canUseTool!(
        'Edit',
        { file_path: file, old_string: 'Câu 2: B\nCâu 3: C\nCâu 4: D', new_string: 'Câu 2: B\nCâu 3: C mới\nCâu 4: D' },
        { signal: new AbortController().signal } as never,
      );
      yield m({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
    });
    const session = new AgentSession({ cwd: () => dir, claudeBin: '/x', emit: (e) => events.push(e), queryFn: fake.fn });
    await session.send('sửa', [], SETTINGS);
    await until(() => events.some((e) => e.kind === 'permission'));
    const perm = events.find((e) => e.kind === 'permission');
    if (perm?.kind !== 'permission') throw new Error('thiếu yêu cầu');
    expect(perm.input.file_path).toBe('de.md');
    expect(perm.fileChange).toEqual({
      path: 'de.md',
      kind: 'edit',
      additions: 1,
      deletions: 1,
      hunks: [{ oldStart: 4, newStart: 4, lines: [' Câu 2: B', '-Câu 3: C', '+Câu 3: C mới', ' Câu 4: D'] }],
    });
    session.respondPermission(perm.id, false);
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('báo lỗi tài khoản bằng tiếng Việt', async () => {
    const { session, events } = setup(async function* () {
      yield m({ type: 'assistant', parent_tool_use_id: null, error: 'rate_limit', message: { id: 'e1', content: [] } });
      yield m({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 5, errors: ['hết lượt'] });
    });
    await session.send('Chào', [], SETTINGS);
    await until(() => events.some((e) => e.kind === 'result'));
    expect(events).toContainEqual({ kind: 'error', message: 'Đã chạm giới hạn sử dụng của gói Claude. Hãy thử lại sau.' });
    expect(events).toContainEqual({ kind: 'result', isError: true, durationMs: 5, message: 'hết lượt' });
  });

  it('cấu hình phiên: không lộ API key, đổi model/chế độ tại chỗ, đổi effort thì chạy lại và giữ hội thoại', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-khong-duoc-dung';
    const { session, events, fake } = setup(async function* () {
      yield m({ type: 'system', subtype: 'init', session_id: 'phien-1' });
      yield m({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
    });
    await session.send('một', [], SETTINGS);
    delete process.env.ANTHROPIC_API_KEY;
    await until(() => events.filter((e) => e.kind === 'result').length === 1);

    const first = fake.created[0]!.options;
    expect(first.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(first.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(first).toMatchObject({ cwd: CWD, model: 'claude-opus-5-5', effort: 'medium', permissionMode: 'default', includePartialMessages: true });

    await session.send('hai', [], { ...SETTINGS, model: 'claude-sonnet-5-5', mode: 'auto' });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.models).toEqual(['claude-sonnet-5-5']);
    expect(fake.created[0]!.modes).toEqual(['acceptEdits']);
    await until(() => events.filter((e) => e.kind === 'result').length === 2);

    await session.send('ba', [], { model: 'claude-haiku-4-5', effort: null, mode: 'plan' });
    expect(fake.created).toHaveLength(2);
    expect(fake.created[0]!.closed).toBe(true);
    const second = fake.created[1]!.options;
    expect(second).toMatchObject({ resume: 'phien-1', permissionMode: 'plan', model: 'claude-haiku-4-5' });
    expect('effort' in second).toBe(false);
  });

  it('hồ sơ dựng sẵn: ghép vào system prompt và đăng ký subagent khi bắt đầu phiên', async () => {
    const fake = fakeQueryFn(async function* () {
      yield m({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
    });
    const reviewer = { description: 'Phản biện', prompt: 'Tìm lỗi.', tools: ['Read'] };
    const session = new AgentSession({
      cwd: () => CWD,
      claudeBin: '/khong/can',
      emit: () => {},
      queryFn: fake.fn,
      profile: () => ({ info: { dir: '/hs', outputStyle: null, agents: [], hasInstructions: true }, systemAppend: 'QUY TRÌNH KHOA HỌC', agents: { reviewer } }),
    });
    await session.send('một', [], SETTINGS);
    const opts = fake.created[0]!.options;
    expect(opts.agents).toEqual({ reviewer });
    expect(opts.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
    const append = (opts.systemPrompt as { append: string }).append;
    expect(append.startsWith('Người dùng là người đọc sách')).toBe(true);
    expect(append.endsWith('QUY TRÌNH KHOA HỌC')).toBe(true);
    await session.close();
  });

  it('bấm dừng: kết quả lỗi do dừng được báo là "đã dừng", không hiện thông báo kỹ thuật', async () => {
    let release!: () => void;
    const { session, events } = setup(async function* () {
      await new Promise<void>((r) => (release = r));
      yield m({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 9, errors: ['[ede_diagnostic] ...'] });
    });
    await session.send('viết dài', [], SETTINGS);
    await until(() => !!release);
    await session.interrupt();
    release();
    await until(() => events.some((e) => e.kind === 'result'));
    expect(events.find((e) => e.kind === 'result')).toEqual({ kind: 'result', isError: false, durationMs: 9, interrupted: true });
  });

  it('xóa hội thoại thì phiên sau không tiếp tục phiên cũ', async () => {
    const { session, events, fake } = setup(async function* () {
      yield m({ type: 'system', subtype: 'init', session_id: 'cu' });
      yield m({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
    });
    await session.send('một', [], SETTINGS);
    await until(() => events.some((e) => e.kind === 'result'));
    await session.clear();
    expect(session.events()).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: 'cleared' });
    await session.send('mới', [], SETTINGS);
    expect('resume' in fake.created[1]!.options).toBe(false);
  });
});

describe('quản lý phiên', () => {
  const sessionMsgs = [
    { type: 'user', uuid: 'u1', session_id: 'cu', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: 'Sửa câu 2\n\nFile liên quan (đường dẫn trong thư mục làm việc):\n- de.md' } },
    {
      type: 'assistant', uuid: 'a1', session_id: 'cu', parent_tool_use_id: null, parent_agent_id: null,
      message: { id: 'm1', content: [{ type: 'text', text: 'Đã sửa.' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: `${CWD}/de.md`, old_string: 'cũ', new_string: 'mới' } }] },
    },
    { type: 'user', uuid: 'u2', session_id: 'cu', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'user', uuid: 'u3', session_id: 'cu', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: '<command-name>/compact</command-name>' } },
    { type: 'user', uuid: 'u4', session_id: 'cu', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: [{ type: 'text', text: 'Cảm ơn' }] } },
  ];

  function withSessions() {
    const calls: string[] = [];
    const sessions = {
      list: async () => [
        { sessionId: 'cu', summary: 'tóm tắt', firstPrompt: 'Sửa câu 2\n\nFile liên quan (đường dẫn trong thư mục làm việc):\n- de.md', lastModified: 100, cwd: CWD },
        { sessionId: 'moi-hon', summary: '', customTitle: 'Đề giữa kỳ', lastModified: 200, cwd: CWD },
        { sessionId: 'thu-muc-khac', summary: 'x', lastModified: 300, cwd: '/noi-khac' },
      ],
      messages: async () => sessionMsgs as never,
      rename: async (id: string, title: string) => void calls.push(`rename ${id} ${title}`),
      remove: async (id: string) => void calls.push(`remove ${id}`),
    };
    const events: AgentEvent[] = [];
    const replays: AgentEvent[][] = [];
    const fake = fakeQueryFn(async function* () {
      yield m({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
    });
    const session = new AgentSession({
      cwd: () => CWD, claudeBin: '/x', emit: (e) => events.push(e), replay: (r) => replays.push(r), queryFn: fake.fn, sessions,
    });
    return { session, events, replays, fake, calls };
  }

  it('liệt kê phiên của thư mục hiện tại, mới nhất trước, tiêu đề dễ đọc', async () => {
    const { session } = withSessions();
    expect(await session.listSessions()).toEqual([
      { id: 'moi-hon', title: 'Đề giữa kỳ', lastModified: 200, current: false },
      { id: 'cu', title: 'Sửa câu 2', lastModified: 100, current: false },
    ]);
  });

  it('macOS: thư mục tên có dấu ở dạng tách dấu (NFD) vẫn thấy phiên Claude ghi ở dạng NFC', async () => {
    const nfc = '/Users/tuan/Tài liệu/chấm thi';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    const sessions = {
      list: async () => [
        { sessionId: 'a', summary: 'Đề 1', lastModified: 1, cwd: nfc },
        { sessionId: 'b', summary: 'khác', lastModified: 2, cwd: '/Users/tuan/Khác' },
      ],
      messages: async () => [] as never,
      rename: async () => {},
      remove: async () => {},
    };
    const session = new AgentSession({ cwd: () => nfd, claudeBin: '/x', emit: () => {}, sessions });
    expect((await session.listSessions()).map((x) => x.id)).toEqual(['a']);
  });

  it('mở lại phiên: dựng lại hội thoại (kể cả thẻ thay đổi file), gửi tiếp thì tiếp tục phiên đó', async () => {
    const { session, replays, fake } = withSessions();
    await session.openSession('cu');
    const r = replays[0]!;
    expect(r.map((e) => e.kind)).toEqual(['user', 'block', 'block', 'tool-result', 'result', 'user', 'result']);
    expect(r[0]).toMatchObject({ kind: 'user', text: 'Sửa câu 2', files: ['de.md'] });
    const tr = r[3];
    expect(tr?.kind === 'tool-result' && tr.fileChange).toMatchObject({ path: 'de.md', additions: 1, deletions: 1 });
    expect(r[5]).toMatchObject({ kind: 'user', text: 'Cảm ơn' });
    expect((await session.listSessions()).find((s) => s.id === 'cu')?.current).toBe(true);

    await session.send('Tiếp', [], SETTINGS);
    expect(fake.created[0]!.options).toMatchObject({ resume: 'cu' });
  });

  it('đổi tên, xóa phiên (xóa phiên đang mở thì bắt đầu hội thoại mới)', async () => {
    const { session, events, calls } = withSessions();
    await session.openSession('cu');
    await session.renameSession('cu', 'Đề 15 phút');
    await session.deleteSession('cu');
    expect(calls).toEqual(['rename cu Đề 15 phút', 'remove cu']);
    expect(events.at(-1)).toEqual({ kind: 'cleared' });
    expect(session.sessionId).toBeNull();
  });
});

describe('sameDir', () => {
  it('cùng thư mục dù khác dạng Unicode, khác hoa thường (Mac/Windows), có hay không dấu / ở cuối', () => {
    const p = '/Users/tuan/Tài liệu/Chấm thi';
    expect(sameDir(p, p.normalize('NFD'), 'darwin')).toBe(true);
    expect(sameDir(p, '/users/TUAN/tài liệu/chấm thi/', 'darwin')).toBe(true);
    expect(sameDir(p, '/users/TUAN/tài liệu/chấm thi', 'linux')).toBe(false);
    expect(sameDir(p, '/Users/tuan/Tài liệu/Chấm thi 2', 'darwin')).toBe(false);
  });

  it('giải liên kết thư mục (như /tmp → /private/tmp trên Mac)', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'samedir-'));
    const real = path.join(base, 'that');
    const link = path.join(base, 'lien-ket');
    mkdirSync(real);
    symlinkSync(real, link);
    expect(sameDir(link, real)).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('connector', () => {
  it('liệt kê connector kèm trạng thái và công cụ chỉ đọc', () => {
    expect(toConnectorInfo(MCP_STATUSES[0]!)).toEqual({
      key: 'claude.ai Consensus',
      name: 'Consensus',
      status: 'connected',
      source: 'claudeai',
      tools: [
        { name: 'search', description: 'Search papers', readOnly: true },
        { name: 'save_search', readOnly: false },
      ],
    });
  });

  it('chỉ tự cho phép công cụ chỉ đọc của connector claude.ai / cấu hình riêng', () => {
    const consensus = { name: 'claude.ai Consensus', source: 'claudeai' };
    expect(isTrustedReadOnlyMcpTool('mcp__claude_ai_Consensus__search', consensus, MCP_STATUSES)).toBe(true);
    expect(isTrustedReadOnlyMcpTool('mcp__claude_ai_Consensus__save_search', consensus, MCP_STATUSES)).toBe(false);
    // Connector của thư mục (project) có thể do người khác cài sẵn: vẫn hỏi.
    expect(isTrustedReadOnlyMcpTool('mcp__du-an__search', { name: 'du-an', source: 'project' }, MCP_STATUSES)).toBe(false);
    expect(isTrustedReadOnlyMcpTool('mcp__claude_ai_Consensus__search', undefined, MCP_STATUSES)).toBe(false);
  });

  it('chế độ Hỏi trước: tìm bài báo trên Consensus không hỏi, lưu tìm kiếm thì hỏi', async () => {
    const decisions: unknown[] = [];
    const { session, events } = setup(async function* (_user, options) {
      const opts = (server: string) => ({ signal: new AbortController().signal, suggestions: [], mcpServer: { name: server, source: 'claudeai' } }) as never;
      decisions.push(await options.canUseTool!('mcp__claude_ai_Consensus__search', { query: 'PCR' }, opts('claude.ai Consensus')));
      void options.canUseTool!('mcp__claude_ai_Consensus__save_search', { query: 'PCR' }, opts('claude.ai Consensus'));
      yield m({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
    });
    await session.send('Tìm bài báo', [], SETTINGS);
    await until(() => events.some((e) => e.kind === 'permission'));
    expect(decisions[0]).toMatchObject({ behavior: 'allow' });
    const perms = events.filter((e) => e.kind === 'permission');
    expect(perms.map((p) => p.kind === 'permission' && p.toolName)).toEqual(['mcp__claude_ai_Consensus__save_search']);
    await session.close();
  });

  it('chưa có phiên: mở tạm một phiên để hỏi connector rồi đóng, không gửi câu hỏi nào', async () => {
    const { session, fake } = setup(async function* () {
      throw new Error('không được gửi câu hỏi');
    });
    const list = await session.connectors();
    expect(list.map((c) => [c.name, c.status])).toEqual([
      ['Consensus', 'connected'],
      ['Scite', 'needs-auth'],
      ['du-an', 'connected'],
    ]);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.closed).toBe(true);
  });
});
