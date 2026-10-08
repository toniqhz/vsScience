import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AuthStatus, ClaudeProfileInfo } from '@ide/shared';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { agentReducer, initialAgentState, type LocalNode } from '../chat/agentStore';
import { COMMANDS, type CommandAction } from '../chat/commands';
import { Composer, type ComposerMenu } from '../chat/Composer';
import { LoginDialog, planLabel } from '../chat/LoginDialog';
import { DEFAULT_MODEL, findModel, type Effort, type PermissionMode } from '../chat/models';
import { Transcript, agentLabel } from '../chat/Transcript';
import { UsageCard } from '../chat/UsageCard';
import { PackDialog, wasPackAsked } from '../chat/PackDialog';
import { PlanPanel } from '../chat/PlanPanel';
import { derivePlan, planVersion } from '../chat/plan';

const SUGGESTIONS = [
  { icon: 'codicon-checklist', title: 'Soạn câu trắc nghiệm', prompt: '/soan-trac-nghiem' },
  { icon: 'codicon-book', title: 'Tóm tắt tài liệu', prompt: '/tom-tat' },
  { icon: 'codicon-symbol-array', title: 'Trộn mã đề', prompt: '/tron-de' },
  { icon: 'codicon-question', title: 'Xem các lệnh', prompt: '/help' },
];

const PREFS_KEY = 'ide.chat.prefs';
const PLAN_DISMISSED_KEY = 'ide.chat.planDismissed';
type Prefs = { model: string; effort: Effort | null; mode: PermissionMode };

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '') as Partial<Prefs>;
    const model = findModel(p.model ?? '');
    const effort = p.effort && model.efforts.includes(p.effort) ? p.effort : model.defaultEffort;
    const mode = p.mode === 'auto' || p.mode === 'plan' ? p.mode : 'ask';
    return { model: model.id, effort, mode };
  } catch {
    return { model: DEFAULT_MODEL.id, effort: DEFAULT_MODEL.defaultEffort, mode: 'ask' };
  }
}

/**
 * Khu vực làm việc chính với Claude. Phiên trợ lý chạy ở server (Claude Agent SDK);
 * hội thoại dựng từ luồng sự kiện qua WebSocket, nên tải lại trang vẫn giữ nguyên.
 */
export function ChatPanel({ activePath, onOpenFile }: { activePath: string | null; onOpenFile: (path: string) => void }) {
  const { onAgent, planUsage, refreshUsage, packs } = useWorkspace();
  const [packOpen, setPackOpen] = useState<string | null>(null);
  const dataPack = packs?.find((p) => p.id === 'data') ?? null;
  // Lần đầu mở app (bản desktop): hỏi có cài gói phân tích số liệu không.
  useEffect(() => {
    if (dataPack?.state === 'missing' && !wasPackAsked('data')) setPackOpen('data');
  }, [dataPack?.state]);
  const openPack = packs?.find((p) => p.id === packOpen) ?? null;
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [menu, setMenu] = useState<ComposerMenu>(null);
  const [agent, dispatch] = useReducer(agentReducer, initialAgentState);
  /** Yêu cầu điền chữ vào ô chat (từ thẻ gợi ý) và đưa con trỏ vào đó. */
  const [insertRequest, setInsertRequest] = useState<{ text: string; n: number } | null>(null);
  const focusComposer = (text = '') => setInsertRequest((r) => ({ text, n: (r?.n ?? 0) + 1 }));
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const model = findModel(prefs.model);
  const contextTotal = agent.context?.max ?? model.contextWindow;

  useEffect(() => onAgent((msg) => dispatch(msg)), [onAgent]);

  const [profile, setProfile] = useState<ClaudeProfileInfo | null>(null);
  useEffect(() => {
    api.agentProfile().then(setProfile, () => setProfile(null));
  }, []);

  useEffect(() => {
    api
      .authStatus()
      .then(setAuth)
      .catch(() => setAuth({ loggedIn: false, method: 'none', email: null, plan: null, orgName: null }));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // không lưu được lựa chọn — vẫn dùng trong phiên này
    }
  }, [prefs]);

  // Tự cuộn theo câu trả lời, trừ khi người dùng đã cuộn lên đọc lại.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [agent.seq]);

  // Giữ bám đáy cả khi kích thước đổi mà không có sự kiện mới: ô chat giãn ra khi gõ nhiều dòng,
  // dải hạn mức hiện dưới ô chat, thẻ xin quyền vẽ xong sau. Không có đoạn này, phần cuối hội thoại
  // bị khuất sau ô chat.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const stick = () => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    };
    const ro = new ResizeObserver(stick);
    ro.observe(el);
    const observeContent = () => {
      for (const child of Array.from(el.children)) ro.observe(child);
    };
    observeContent();
    // Nội dung bên trong được thay (màn hình chào ↔ hội thoại): theo dõi phần tử mới.
    const mo = new MutationObserver(() => {
      observeContent();
      stick();
    });
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  const plan = useMemo(() => derivePlan(agent.items), [agent.items]);
  const planKey = useMemo(() => planVersion(agent.items), [agent.items]);
  // Người dùng bấm đóng: nhớ phiên bản kế hoạch lúc đóng; Claude cập nhật kế hoạch thì hiện lại.
  const [dismissedPlan, setDismissedPlan] = useState<string | null>(() => {
    try {
      return localStorage.getItem(PLAN_DISMISSED_KEY);
    } catch {
      return null;
    }
  });
  const closePlan = () => {
    setDismissedPlan(planKey);
    try {
      if (planKey) localStorage.setItem(PLAN_DISMISSED_KEY, planKey);
    } catch {
      // chỉ là tiện ích
    }
  };
  // Xong hết các bước thì bỏ bảng khi lượt trả lời kết thúc (trong lượt vẫn hiện để thấy bước cuối được đánh dấu).
  const planDone = plan.length > 0 && plan.every((s) => s.status === 'completed');
  const showPlan = plan.length > 0 && planKey !== dismissedPlan && !(planDone && !agent.running);
  /** Cuộn tới chỗ một bước của kế hoạch được cập nhật gần nhất và nháy sáng chỗ đó. */
  const jumpTo = (key: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-keys~="${CSS.escape(key)}"]`);
    if (!el) return;
    stickToBottom.current = false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  };

  // Ô chat nổi đè lên cuối hội thoại (như VS Code): báo chiều cao của nó để hội thoại chừa đủ chỗ cuộn
  // dòng cuối lên trên ô chat.
  useEffect(() => {
    const wrap = composerRef.current;
    const panel = panelRef.current;
    if (!wrap || !panel) return;
    const ro = new ResizeObserver(() => {
      panel.style.setProperty('--composer-h', `${wrap.offsetHeight}px`);
      const el = scrollRef.current;
      if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  const local = useCallback((node: LocalNode) => dispatch({ type: 'local', node }), []);
  const fail = useCallback((e: Error) => local({ kind: 'notice', tone: 'warn', text: e.message }), [local]);

  const send = (text: string, files: string[] = []) => {
    stickToBottom.current = true;
    api.agentSend({ text, files, model: prefs.model, effort: prefs.effort, mode: prefs.mode }).catch(fail);
  };

  const runCommand = (action: CommandAction) => {
    switch (action) {
      case 'clear':
        api.agentClear().catch(fail);
        return;
      case 'compact':
        if (!agent.context) {
          local({ kind: 'notice', tone: 'info', text: 'Chưa có hội thoại để tóm gọn.' });
          return;
        }
        // Lệnh /compact của Claude Code: tóm gọn hội thoại để giải phóng ngữ cảnh.
        send('/compact');
        return;
      case 'context':
        api
          .agentContext()
          .then((usage) => local({ kind: 'context', usage: usage ?? agent.context, modelName: model.name, fallbackMax: model.contextWindow }))
          .catch(fail);
        return;
      case 'model':
        setMenu('model');
        return;
      case 'mode':
        setMenu('mode');
        return;
      case 'login':
        setLoginOpen(true);
        return;
      case 'logout':
        // Phiên đăng nhập dùng chung với Claude Code, nên đăng xuất ở đây cũng đăng xuất plugin VS Code.
        if (!window.confirm('Đăng xuất Claude sẽ đăng xuất cả Claude Code (plugin VS Code) trên máy này. Tiếp tục?')) return;
        api
          .logout()
          .then((s) => {
            setAuth(s);
            local({ kind: 'notice', tone: 'info', text: 'Đã đăng xuất tài khoản Claude trên máy này.' });
          })
          .catch(fail);
        return;
      case 'packs':
        if (!dataPack) {
          local({ kind: 'notice', tone: 'info', text: 'Gói tùy chọn chỉ có trong app desktop. Khi chạy dev, Claude dùng Python có sẵn trên máy.' });
          return;
        }
        setPackOpen('data');
        return;
      case 'help':
        local({ kind: 'help' });
        return;
    }
  };

  const connected = !!auth?.loggedIn;

  const onConnected = useCallback(
    (s: AuthStatus) => {
      setAuth(s);
      setLoginOpen(false);
      const plan = s.plan ? ` · gói ${planLabel(s.plan)}` : '';
      local({ kind: 'notice', tone: 'info', text: `Đã đăng nhập Claude: ${s.email ?? 'tài khoản Claude'}${plan}.` });
      setInsertRequest((r) => ({ text: '', n: (r?.n ?? 0) + 1 }));
    },
    [local],
  );

  return (
    <div className="chat-panel" ref={panelRef}>
      {showPlan && <PlanPanel steps={plan} onJump={jumpTo} onClose={closePlan} />}
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {agent.items.length === 0 ? (
          <div className="chat-column chat-welcome">
            <img className="chat-logo" src="/logo.png" alt="VsScience" />
            <h1>Hôm nay bạn muốn làm gì?</h1>
            <p className="chat-subtitle">
              Claude đọc tài liệu trong thư mục của bạn, soạn câu hỏi kèm số trang và sửa đề thi. Gõ <kbd>@</kbd> để nhắc
              tới file, <kbd>/</kbd> để gọi lệnh.
            </p>
            {profile && <ProfileBadge profile={profile} />}
            {dataPack && dataPack.state !== 'installed' && (
              <button className="link-btn pack-hint" onClick={() => setPackOpen('data')}>
                <span className="codicon codicon-cloud-download" />{' '}
                {dataPack.state === 'installing' ? `Đang cài gói phân tích số liệu… ${dataPack.message ?? ''}` : 'Gói phân tích số liệu (thống kê, biểu đồ) chưa cài · Cài'}
              </button>
            )}
            <div className="suggestions">
              {SUGGESTIONS.map((s) => {
                const cmd = COMMANDS.find((c) => `/${c.name}` === s.prompt);
                return (
                  <button
                    key={s.title}
                    className="suggestion"
                    onClick={() => {
                      if (!connected) return setLoginOpen(true);
                      if (cmd?.kind === 'action') runCommand(cmd.action);
                      else focusComposer(cmd?.kind === 'prompt' ? cmd.template : '');
                    }}
                  >
                    <span className={`codicon ${s.icon} suggestion-icon`} />
                    <span className="suggestion-title">{s.title}</span>
                    <span className="suggestion-prompt">{cmd?.description}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <Transcript
            items={agent.items}
            running={agent.running}
            onOpenFile={onOpenFile}
            onPermission={(id, allow, always) => api.agentPermission(id, allow, always).catch(fail)}
          />
        )}
      </div>
      <div className="chat-column composer-wrap" ref={composerRef}>
        <Composer
          activePath={activePath}
          model={model}
          effort={prefs.effort}
          mode={prefs.mode}
          usedTokens={agent.context?.used ?? 0}
          contextTotal={contextTotal}
          connected={connected}
          running={agent.running}
          onStop={() => api.agentInterrupt().catch(fail)}
          menu={menu}
          insertRequest={insertRequest}
          onMenuChange={setMenu}
          onModelChange={(id) => {
            const m = findModel(id);
            setPrefs((p) => ({
              ...p,
              model: m.id,
              effort: p.effort && m.efforts.includes(p.effort) ? p.effort : m.defaultEffort,
            }));
          }}
          onEffortChange={(effort) => setPrefs((p) => ({ ...p, effort }))}
          onModeChange={(mode) => setPrefs((p) => ({ ...p, mode }))}
          onRequireLogin={() => setLoginOpen(true)}
          onCommand={runCommand}
          onUnknownCommand={(name) =>
            local({ kind: 'notice', tone: 'warn', text: `Không có lệnh /${name}. Gõ /help để xem danh sách lệnh.` })
          }
          onSubmit={send}
        />
        <UsageCard usage={planUsage} onRefresh={() => refreshUsage(true)} />
      </div>
      {openPack && <PackDialog pack={openPack} onClose={() => setPackOpen(null)} />}
      {loginOpen && <LoginDialog status={auth} onClose={() => setLoginOpen(false)} onConnected={onConnected} />}
    </div>
  );
}

/** Cho biết Claude đang chạy với hồ sơ dựng sẵn nào (giọng trả lời, quy trình, subagent). */
function ProfileBadge({ profile }: { profile: ClaudeProfileInfo }) {
  const parts = [
    profile.outputStyle && `Giọng: ${profile.outputStyle}`,
    profile.hasInstructions && 'quy trình lập luận khoa học',
    ...profile.agents.map((a) => `trợ lý ${agentLabel(a.name)}`),
  ].filter(Boolean);
  return (
    <div className="profile-badge" title={`Hồ sơ Claude: ${profile.dir}`}>
      <span className="codicon codicon-beaker" />
      <span>{parts.join(' · ')}</span>
    </div>
  );
}
