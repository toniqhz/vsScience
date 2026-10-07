import type { AgentEvent, ContextUsage, FileChange } from '@ide/shared';

/** Một mục trong hội thoại, dựng từ luồng sự kiện của phiên trợ lý. */
export type Item =
  | { type: 'user'; key: string; text: string; files: string[] }
  | { type: 'text'; key: string; text: string; streaming: boolean }
  | {
      type: 'tool';
      key: string;
      id: string;
      name: string;
      input: Record<string, unknown>;
      result?: { isError: boolean; output: string; fileChange?: FileChange };
    }
  | {
      type: 'permission';
      key: string;
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      fileChange?: FileChange;
      outside?: string[];
      allowed?: boolean;
    }
  | { type: 'result'; key: string; isError: boolean; durationMs: number; message?: string; interrupted?: boolean; changes: FileChange[] }
  | { type: 'error'; key: string; message: string }
  /** Mục chỉ có ở trình duyệt (thông báo của lệnh /help, /context…). */
  | { type: 'local'; key: string; node: LocalNode };

export type LocalNode =
  | { kind: 'notice'; text: string; tone: 'info' | 'warn' }
  | { kind: 'help' }
  | { kind: 'context'; usage: ContextUsage | null; modelName: string; fallbackMax: number };

export interface AgentState {
  items: Item[];
  running: boolean;
  context: ContextUsage | null;
  seq: number;
}

export const initialAgentState: AgentState = { items: [], running: false, context: null, seq: 0 };

export type AgentAction =
  | { type: 'event'; event: AgentEvent }
  | { type: 'replay'; events: AgentEvent[] }
  | { type: 'local'; node: LocalNode };

function upsert(items: Item[], item: Item): Item[] {
  const i = items.findIndex((x) => x.key === item.key);
  if (i < 0) return [...items, item];
  const next = items.slice();
  next[i] = item;
  return next;
}

/** Các file đã sửa trong lượt hiện tại (từ sau tin nhắn người dùng gần nhất). */
function changesThisTurn(items: Item[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.type === 'user') break;
    if (it.type === 'tool' && it.result?.fileChange && !it.result.isError) {
      const fc = it.result.fileChange;
      const prev = byPath.get(fc.path);
      // Gộp nhiều lần sửa cùng một file thành một dòng tổng.
      byPath.set(
        fc.path,
        prev
          ? { ...fc, kind: prev.kind === 'create' || fc.kind === 'create' ? 'create' : 'edit', additions: prev.additions + fc.additions, deletions: prev.deletions + fc.deletions }
          : fc,
      );
    }
  }
  return [...byPath.values()].reverse();
}

function apply(state: AgentState, e: AgentEvent): AgentState {
  const seq = state.seq + 1;
  switch (e.kind) {
    case 'cleared':
      return { ...initialAgentState, seq };
    case 'status':
      return { ...state, seq, running: e.state === 'running' };
    case 'context':
      return { ...state, seq, context: e.usage };
    case 'user':
      return { ...state, seq, items: [...state.items, { type: 'user', key: `u:${e.id}`, text: e.text, files: e.files }] };
    case 'delta': {
      const key = `${e.messageId}:${e.index}`;
      const existing = state.items.find((x) => x.key === key);
      if (existing && (existing.type !== 'text' || !existing.streaming)) return state;
      const text = (existing?.type === 'text' ? existing.text : '') + e.text;
      return { ...state, seq, items: upsert(state.items, { type: 'text', key, text, streaming: true }) };
    }
    case 'block': {
      const key = `${e.messageId}:${e.index}`;
      const b = e.block;
      if (b.type === 'thinking') return state;
      if (b.type === 'text') {
        if (!b.text.trim()) return state;
        return { ...state, seq, items: upsert(state.items, { type: 'text', key, text: b.text, streaming: false }) };
      }
      return { ...state, seq, items: upsert(state.items, { type: 'tool', key, id: b.id, name: b.name, input: b.input }) };
    }
    case 'tool-result': {
      const items = state.items.map((it) =>
        it.type === 'tool' && it.id === e.toolUseId
          ? { ...it, result: { isError: e.isError, output: e.output, fileChange: e.fileChange } }
          : it,
      );
      return { ...state, seq, items };
    }
    case 'permission':
      return {
        ...state,
        seq,
        items: [
          ...state.items,
          { type: 'permission', key: `p:${e.id}`, id: e.id, toolName: e.toolName, input: e.input, fileChange: e.fileChange, outside: e.outside },
        ],
      };
    case 'permission-resolved':
      return {
        ...state,
        seq,
        items: state.items.map((it) => (it.type === 'permission' && it.id === e.id ? { ...it, allowed: e.allowed } : it)),
      };
    case 'result': {
      // Chữ còn đang stream dở (ví dụ khi bấm dừng) coi như đã xong.
      const items = state.items.map((it) => (it.type === 'text' && it.streaming ? { ...it, streaming: false } : it));
      return {
        ...state,
        seq,
        items: [
          ...items,
          {
            type: 'result',
            key: `r:${seq}`,
            isError: e.isError,
            durationMs: e.durationMs,
            message: e.message,
            interrupted: e.interrupted,
            changes: changesThisTurn(items),
          },
        ],
      };
    }
    case 'error':
      return { ...state, seq, items: [...state.items, { type: 'error', key: `e:${seq}`, message: e.message }] };
  }
}

export function agentReducer(state: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case 'event':
      return apply(state, action.event);
    case 'replay':
      return action.events.reduce(apply, { ...initialAgentState, seq: state.seq });
    case 'local':
      return { ...state, seq: state.seq + 1, items: [...state.items, { type: 'local', key: `l:${state.seq + 1}`, node: action.node }] };
  }
}

/** Đang có yêu cầu xin quyền chưa trả lời. */
export function hasPendingPermission(state: AgentState): boolean {
  return state.items.some((it) => it.type === 'permission' && it.allowed === undefined);
}
