import { useEffect, useRef, useState } from 'react';
import type { AuthStatus, LoginProgress } from '@ide/shared';
import { api } from '../api/client';

const PLAN_LABEL: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };

export function planLabel(plan: string | null): string {
  return plan ? (PLAN_LABEL[plan] ?? plan) : '';
}

/**
 * Đăng nhập tài khoản Claude giống plugin VS Code: mở trang Claude.ai trong tab mới,
 * người dùng bấm cấp quyền là xong. Server chạy `claude auth login` của Claude Code CLI,
 * nên phiên đăng nhập dùng chung với Claude Code trên máy.
 */
export function LoginDialog({
  status,
  onClose,
  onConnected,
}: {
  status: AuthStatus | null;
  onClose: () => void;
  onConnected: (s: AuthStatus) => void;
}) {
  const [progress, setProgress] = useState<LoginProgress | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState('');
  const doneRef = useRef(false);

  const waiting = progress?.state === 'waiting';

  // Chờ CLI báo đăng nhập xong (sau khi người dùng cấp quyền trong trình duyệt).
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => {
      api
        .loginProgress()
        .then(async (p) => {
          setProgress(p);
          if (p.state === 'success' && !doneRef.current) {
            doneRef.current = true;
            onConnected(await api.authStatus());
          }
        })
        .catch(() => {});
    }, 1000);
    return () => window.clearInterval(id);
  }, [waiting, onConnected]);

  const close = () => {
    if (waiting) void api.cancelLogin().catch(() => {});
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const openInTab = (url: string, tab?: Window | null) => {
    const w = tab ?? window.open('about:blank', '_blank');
    if (!w) return false;
    w.opener = null;
    w.location.href = url;
    return true;
  };

  const start = () => {
    // Mở tab ngay trong lúc bấm để trình duyệt không chặn popup, rồi mới điền link.
    const tab = window.open('about:blank', '_blank');
    setStarting(true);
    setError(null);
    setShowCode(false);
    setCode('');
    api
      .startLogin()
      .then((p) => {
        setProgress(p);
        const url = p.autoUrl ?? p.manualUrl;
        if (p.state === 'error' || !url) {
          tab?.close();
          setError(p.message ?? 'Không bắt đầu đăng nhập được.');
          return;
        }
        if (!openInTab(url, tab)) setError('Trình duyệt chặn cửa sổ mới — bấm "Mở lại trang đăng nhập".');
        if (!p.autoUrl) setShowCode(true);
      })
      .catch((e: Error) => {
        tab?.close();
        setError(e.message);
      })
      .finally(() => setStarting(false));
  };

  const sendCode = () => {
    if (!code.trim()) return;
    api
      .submitLoginCode(code)
      .then(setProgress)
      .catch((e: Error) => setError(e.message));
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal login-dialog" role="dialog" aria-label="Đăng nhập Claude">
        <div className="modal-header">
          <span className="codicon codicon-sparkle login-logo" />
          <span className="modal-title">Đăng nhập Claude</span>
          <button className="icon-btn" title="Đóng (Esc)" onClick={close}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className="login-body">
          {status?.loggedIn && !waiting && (
            <div className="login-current">
              <span className="codicon codicon-check" /> Đang đăng nhập: <strong>{status.email ?? 'tài khoản Claude'}</strong>
              {status.plan && ` · gói ${planLabel(status.plan)}`}
            </div>
          )}

          {!waiting ? (
            <>
              <p>
                Dùng tài khoản Claude của bạn (gói Pro hoặc Max), giống Claude Code trong VS Code. Trang đăng nhập của
                Claude sẽ mở trong tab mới — đăng nhập rồi bấm <strong>Authorize</strong> là xong.
              </p>
              <button className="btn btn-claude btn-block" onClick={start} disabled={starting}>
                {starting ? 'Đang mở trang đăng nhập…' : status?.loggedIn ? 'Đăng nhập tài khoản khác' : 'Đăng nhập bằng tài khoản Claude'}
              </button>
            </>
          ) : (
            <>
              <div className="login-waiting">
                <span className="codicon codicon-loading codicon-modifier-spin" />
                <div>
                  <strong>Đang chờ bạn cấp quyền trong trình duyệt…</strong>
                  <p>Sau khi bấm Authorize, quay lại đây — cửa sổ này sẽ tự đóng.</p>
                </div>
              </div>
              <div className="login-links">
                <button className="link-btn" onClick={() => openInTab(progress?.autoUrl ?? progress?.manualUrl ?? '')}>
                  Mở lại trang đăng nhập
                </button>
                <button className="link-btn" onClick={() => setShowCode((v) => !v)}>
                  Trình duyệt hiện mã thay vì quay lại?
                </button>
              </div>
              {showCode && (
                <div className="login-code">
                  <p>
                    {progress?.manualUrl ? (
                      <>
                        <button className="link-btn" onClick={() => openInTab(progress.manualUrl!)}>
                          Mở trang lấy mã
                        </button>
                        , đăng nhập và cấp quyền, rồi dán mã hiện ra vào đây:
                      </>
                    ) : (
                      'Dán mã hiện trên trang Claude vào đây:'
                    )}
                  </p>
                  <div className="login-input">
                    <input
                      autoFocus
                      value={code}
                      placeholder="Dán mã…"
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => setCode(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && sendCode()}
                      aria-label="Mã đăng nhập"
                    />
                    <button className="btn btn-primary" onClick={sendCode} disabled={!code.trim()}>
                      Gửi mã
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {(error || progress?.message) && (
            <div className="modal-error login-error">
              <span className="codicon codicon-error" /> {error ?? progress?.message}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <span className="modal-footer-path">Đăng nhập dùng chung với Claude Code trên máy này.</span>
          <button className="btn" onClick={close}>
            {waiting ? 'Hủy' : 'Để sau'}
          </button>
        </div>
      </div>
    </div>
  );
}
