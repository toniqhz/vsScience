import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentEvent, PackInfo, PlanUsage, TreeResponse, WorkspaceInfo } from '@ide/shared';
import { api, connectEvents } from './client';

type FileListener = () => void;
export type AgentListener = (msg: { type: 'event'; event: AgentEvent } | { type: 'replay'; events: AgentEvent[] }) => void;

interface WorkspaceState {
  info: WorkspaceInfo | null;
  tree: TreeResponse | null;
  error: string | null;
  connected: boolean;
  /** Tăng mỗi khi danh sách phiên Claude đổi. */
  sessionsRev: number;
  /** Tăng mỗi khi file hoặc bản lưu đổi (để tải lại danh sách thay đổi). */
  changesRev: number;
  refresh: () => void;
  /** Đăng ký nhận báo khi một file cụ thể thay đổi trên đĩa. Trả về hàm hủy. */
  onFileChange: (path: string, listener: FileListener) => () => void;
  /** Nhận sự kiện của phiên trợ lý (và bản phát lại khi kết nối). Trả về hàm hủy. */
  onAgent: (listener: AgentListener) => () => void;
  /** Hạn mức gói Claude.ai; null khi chưa có hoặc không áp dụng. */
  planUsage: PlanUsage | null;
  refreshUsage: (force?: boolean) => void;
  /** Gói tùy chọn (null khi chưa tải danh sách); rỗng khi chạy dev. */
  packs: PackInfo[] | null;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [sessionsRev, setSessionsRev] = useState(0);
  const [changesRev, setChangesRev] = useState(0);
  const [planUsage, setPlanUsage] = useState<PlanUsage | null>(null);
  const [packs, setPacks] = useState<PackInfo[] | null>(null);
  useEffect(() => {
    api.packs().then(setPacks, () => setPacks([]));
  }, []);
  const refreshUsage = useMemo(
    () => (force = false) => {
      api.usage(force).then((u) => u && setPlanUsage(u), () => {});
    },
    [],
  );
  // Hạn mức đổi chậm: tải khi mở app và mỗi 3 phút (server có bộ nhớ đệm 60 giây).
  useEffect(() => {
    refreshUsage();
    const t = window.setInterval(() => refreshUsage(), 180_000);
    return () => window.clearInterval(t);
  }, [refreshUsage]);
  const listeners = useRef(new Map<string, Set<FileListener>>());
  const agentListeners = useRef(new Set<AgentListener>());
  const refreshTimer = useRef<number | undefined>(undefined);
  const rootRef = useRef<string | null>(null);

  const loadTree = useMemo(
    () => () => {
      api
        .tree()
        .then((t) => {
          setTree(t);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
    },
    [],
  );

  useEffect(() => {
    api
      .workspace()
      .then((w) => {
        rootRef.current ??= w.root;
        setInfo(w);
      })
      .catch((e: Error) => setError(e.message));
    loadTree();

    return connectEvents(
      (event) => {
        if (event.type === 'sessions-changed') {
          setSessionsRev((n) => n + 1);
          return;
        }
        if (event.type === 'pack') {
          const pack = event.pack;
          setPacks((list) => (list ?? []).map((p) => (p.id === pack.id ? pack : p)).concat(list?.some((p) => p.id === pack.id) ? [] : [pack]));
          return;
        }
        if (event.type === 'usage') {
          setPlanUsage(event.usage);
          return;
        }
        if (event.type === 'changes-changed') {
          setChangesRev((n) => n + 1);
          return;
        }
        if (event.type === 'agent') {
          agentListeners.current.forEach((l) => l({ type: 'event', event: event.event }));
          return;
        }
        if (event.type === 'agent-replay') {
          agentListeners.current.forEach((l) => l({ type: 'replay', events: event.events }));
          return;
        }
        if (event.type === 'hello') {
          // Thư mục làm việc vừa đổi (từ tab này hoặc tab khác): tải lại cây.
          if (rootRef.current !== null && rootRef.current !== event.workspace.root) loadTree();
          rootRef.current = event.workspace.root;
          setInfo(event.workspace);
          return;
        }
        setChangesRev((n) => n + 1);
        let structural = false;
        for (const change of event.changes) {
          if (change.event === 'change') {
            listeners.current.get(change.path)?.forEach((l) => l());
          } else {
            structural = true;
          }
        }
        if (structural) {
          window.clearTimeout(refreshTimer.current);
          refreshTimer.current = window.setTimeout(loadTree, 200);
        }
      },
      (ok) => {
        setConnected(ok);
        // Nối lại sau khi mất kết nối: có thể đã lỡ sự kiện, tải lại cây.
        if (ok) loadTree();
      },
    );
  }, [loadTree]);

  const value = useMemo<WorkspaceState>(
    () => ({
      info,
      tree,
      error,
      connected,
      sessionsRev,
      changesRev,
      refresh: loadTree,
      onFileChange: (path, listener) => {
        const set = listeners.current.get(path) ?? new Set();
        set.add(listener);
        listeners.current.set(path, set);
        return () => {
          set.delete(listener);
          if (set.size === 0) listeners.current.delete(path);
        };
      },
      onAgent: (listener) => {
        agentListeners.current.add(listener);
        return () => {
          agentListeners.current.delete(listener);
        };
      },
      planUsage,
      refreshUsage,
      packs,
    }),
    [info, tree, error, connected, sessionsRev, changesRev, loadTree, planUsage, refreshUsage, packs],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace phải nằm trong WorkspaceProvider');
  return ctx;
}
