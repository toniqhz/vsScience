import type {
  AgentMode,
  AgentSessionInfo,
  AuthStatus,
  ChangesResponse,
  ClaudeProfileInfo,
  ContextUsage,
  DirListing,
  FileDiff,
  LoginProgress,
  PlanUsage,
  RestoreResult,
  ServerEvent,
  SnapshotDetail,
  TreeResponse,
  WorkspaceInfo,
} from '@ide/shared';

const TOKEN_KEY = 'ide.token';

/**
 * Lấy token từ ?token= trên URL (lần đầu mở từ link server in ra),
 * lưu lại cho các lần sau, rồi xóa khỏi thanh địa chỉ.
 */
function initToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // trình duyệt chặn storage — vẫn dùng được trong phiên này
    }
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.toString());
    return fromUrl;
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let token = initToken();

export function hasToken(): boolean {
  return !!token;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request(path: string, body?: object): Promise<Response> {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  if (!res.ok) {
    let message = `Lỗi ${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // không phải JSON
    }
    if (res.status === 401) {
      token = null;
      try {
        localStorage.removeItem(TOKEN_KEY);
      } catch {
        // bỏ qua
      }
    }
    throw new ApiError(message, res.status);
  }
  return res;
}

export const api = {
  workspace: async () => (await request('/api/workspace')).json() as Promise<WorkspaceInfo>,
  tree: async () => (await request('/api/tree')).json() as Promise<TreeResponse>,
  fileBytes: async (path: string) =>
    new Uint8Array(await (await request(`/api/file?path=${encodeURIComponent(path)}`)).arrayBuffer()),
  openWorkspace: async (path: string) =>
    (await request('/api/workspace', { path })).json() as Promise<WorkspaceInfo>,
  listDirs: async (path?: string) =>
    (await request(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`)).json() as Promise<DirListing>,
  createFolder: async (parent: string, name: string) =>
    (await request('/api/fs/folder', { parent, name })).json() as Promise<{ path: string }>,
  createFile: async (parent: string, name: string) =>
    (await request('/api/fs/file', { parent, name })).json() as Promise<{ path: string }>,
  authStatus: async () => (await request('/api/auth/status')).json() as Promise<AuthStatus>,
  startLogin: async () => (await request('/api/auth/login', {})).json() as Promise<LoginProgress>,
  loginProgress: async () => (await request('/api/auth/login')).json() as Promise<LoginProgress>,
  submitLoginCode: async (code: string) =>
    (await request('/api/auth/login/code', { code })).json() as Promise<LoginProgress>,
  cancelLogin: async () => (await request('/api/auth/login/cancel', {})).json() as Promise<LoginProgress>,
  logout: async () => (await request('/api/auth/logout', {})).json() as Promise<AuthStatus>,
  agentSend: async (body: { text: string; files: string[]; model: string; effort: string | null; mode: AgentMode }) =>
    void (await request('/api/agent/message', body)),
  agentInterrupt: async () => void (await request('/api/agent/interrupt', {})),
  agentPermission: async (id: string, allow: boolean, always = false) =>
    void (await request('/api/agent/permission', { id, allow, always })),
  agentClear: async () => void (await request('/api/agent/clear', {})),
  agentProfile: async () =>
    ((await (await request('/api/agent/profile')).json()) as { profile: ClaudeProfileInfo | null }).profile,
  agentContext: async () => ((await (await request('/api/agent/context')).json()) as { usage: ContextUsage | null }).usage,
  sessions: async () => (await request('/api/agent/sessions')).json() as Promise<AgentSessionInfo[]>,
  openSession: async (id: string) => void (await request('/api/agent/sessions/open', { id })),
  renameSession: async (id: string, title: string) => void (await request('/api/agent/sessions/rename', { id, title })),
  deleteSession: async (id: string) => void (await request('/api/agent/sessions/delete', { id })),
  changes: async () => (await request('/api/changes')).json() as Promise<ChangesResponse>,
  changeDiff: async (path: string) =>
    (await request(`/api/changes/diff?path=${encodeURIComponent(path)}`)).json() as Promise<FileDiff>,
  saveSnapshot: async (message: string) =>
    ((await (await request('/api/changes/snapshot', { message })).json()) as { saved: boolean }).saved,
  usage: async (refresh = false) =>
    ((await (await request(`/api/usage${refresh ? '?refresh=1' : ''}`)).json()) as { usage: PlanUsage | null }).usage,
  openExternal: async (path: string) => void (await request('/api/file/open-external', { path })),
  restoreFile: async (path: string) => void (await request('/api/changes/restore', { path })),
  snapshotDetail: async (id: string) =>
    (await request(`/api/changes/snapshots/detail?id=${id}`)).json() as Promise<SnapshotDetail>,
  snapshotDiff: async (id: string, path: string) =>
    (await request(`/api/changes/snapshots/diff?id=${id}&path=${encodeURIComponent(path)}`)).json() as Promise<FileDiff>,
  restoreSnapshot: async (id: string, path?: string) =>
    (await request('/api/changes/snapshots/restore', path ? { id, path } : { id })).json() as Promise<RestoreResult>,
};

/**
 * Kết nối WebSocket nhận sự kiện từ server, tự nối lại khi mất kết nối.
 * Trả về hàm hủy.
 */
export function connectEvents(
  onEvent: (e: ServerEvent) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let ws: WebSocket | undefined;
  let retry: number | undefined;
  let delay = 500;
  let stopped = false;

  const open = () => {
    if (!token) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${window.location.host}/api/events?token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      delay = 500;
      onStatus(true);
    };
    ws.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data as string) as ServerEvent);
      } catch {
        // bỏ qua thông điệp hỏng
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (stopped) return;
      retry = window.setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };

  open();
  return () => {
    stopped = true;
    window.clearTimeout(retry);
    if (!ws) return;
    ws.onmessage = null;
    ws.onclose = null;
    // Đóng khi còn đang bắt tay (StrictMode mount 2 lần) làm proxy của Vite báo EPIPE;
    // đợi kết nối mở xong rồi đóng êm.
    if (ws.readyState === WebSocket.CONNECTING) {
      const pending = ws;
      pending.onopen = () => pending.close();
    } else {
      ws.close();
    }
  };
}
