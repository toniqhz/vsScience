import { useEffect, useState } from 'react';
import type { CloudFolderStatus, CloudProviderId, CloudStatus } from '@ide/shared';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';
import { timeAgo } from '../format';

/**
 * Biểu tượng và dòng mô tả trạng thái đồng bộ của thư mục đang mở. tone: '' chưa bật (xám); is-on đã kết nối và
 * bật đồng bộ (vàng); is-busy đang tải lên (vàng, nhấp nháy); is-warn có lỗi / máy khác có bản mới hơn (chấm đỏ).
 */
export function cloudBadge(cloud: CloudStatus | null): { icon: string; title: string; tone: '' | 'is-on' | 'is-busy' | 'is-warn' } {
  if (!cloud?.folder) return { icon: 'codicon-cloud', title: 'Đồng bộ đám mây (chưa bật)', tone: '' };
  const s = cloud.sync;
  const provider = cloud.providers.find((p) => p.id === cloud.folder!.provider);
  if (!provider?.account) return { icon: 'codicon-cloud', title: `Máy này chưa kết nối ${provider?.name ?? 'tài khoản đám mây'}`, tone: 'is-warn' };
  if (s.state === 'syncing') return { icon: 'codicon-cloud-upload', title: syncLine(s), tone: 'is-busy' };
  if (s.state === 'error' || s.state === 'behind') return { icon: 'codicon-cloud', title: syncLine(s), tone: 'is-warn' };
  return { icon: 'codicon-cloud', title: `${provider.name}: ${syncLine(s)}`, tone: 'is-on' };
}

function syncLine(s: CloudFolderStatus): string {
  switch (s.state) {
    case 'syncing':
      return s.progress?.total ? `Đang tải lên ${s.progress.done}/${s.progress.total}…` : 'Đang đồng bộ…';
    case 'synced':
      return `Đã đồng bộ${s.lastSync ? ` ${timeAgo(s.lastSync)}` : ''}`;
    case 'behind':
      return `${s.remoteDevice ? `Máy «${s.remoteDevice}»` : 'Máy khác'} đã đồng bộ bản mới hơn${s.remoteTime ? ` (${timeAgo(s.remoteTime)})` : ''}. Chưa đẩy bản trên máy này lên để không ghi đè.`;
    case 'error':
      return s.error ?? 'Đồng bộ lỗi';
    default:
      return s.lastSync ? `Đồng bộ lần cuối ${timeAgo(s.lastSync)}` : 'Sẽ đồng bộ khi có bản lưu mới';
  }
}

/**
 * Đồng bộ thư mục lên OneDrive / Google Drive: kết nối tài khoản (mỗi máy đăng nhập riêng), bật đồng bộ
 * cho thư mục đang mở, xem trạng thái. App chỉ đẩy lên khi có bản lưu mới.
 */
export function CloudDialog({ onClose }: { onClose: () => void }) {
  const { cloud, setCloud, info } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.cloud().then(setCloud, (e: Error) => setError(e.message));
  }, [setCloud]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Đăng nhập xong (server báo hết "đang kết nối"): bỏ link mở lại.
  useEffect(() => {
    if (!cloud?.connecting) setLoginUrl(null);
  }, [cloud?.connecting]);

  const run = (p: Promise<unknown>) => {
    setBusy(true);
    setError(null);
    p.catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };

  const connect = (id: CloudProviderId) =>
    run(
      api.cloudConnect(id).then(({ url }) => {
        if (!url) return;
        setLoginUrl(url);
        window.open(url, '_blank', 'noopener');
      }),
    );

  const providers = cloud?.providers ?? [];
  const connected = providers.filter((p) => p.account);
  const folder = cloud?.folder ?? null;
  const folderProvider = folder ? cloud?.providers.find((p) => p.id === folder.provider) : null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal cloud-dialog" role="dialog" aria-label="Đồng bộ đám mây">
        <div className="modal-header">
          <span className="codicon codicon-cloud" />
          <span className="modal-title">Đồng bộ đám mây</span>
          <button className="icon-btn" title="Đóng (Esc)" onClick={onClose}>
            <span className="codicon codicon-close" />
          </button>
        </div>
        <div className="cloud-body">
          <p className="cloud-hint">
            Đồng bộ thư mục đang mở lên ổ đám mây của bạn để mở tiếp trên máy khác: tài liệu, đoạn chat với Claude, các bản lưu. App chỉ đẩy lên khi
            có bản lưu mới, và chỉ phần đã đổi. App chỉ được dùng thư mục riêng của nó trên ổ, không thấy các file khác của bạn.
          </p>

          <div className="cloud-section-title">Tài khoản trên máy này</div>
          {providers.map((p) => (
            <div key={p.id} className="cloud-provider">
              <span className={`codicon ${p.id === 'local' ? 'codicon-folder' : 'codicon-cloud'}`} />
              <span className="cloud-provider-name">
                {p.name}
                {p.account ? (
                  <span className="cloud-provider-account">{p.account.email ?? p.account.name}</span>
                ) : (
                  p.note && p.id !== 'gdrive' && <span className="cloud-provider-account">{p.note}</span>
                )}
              </span>
              {p.account ? (
                <button className="btn" disabled={busy} onClick={() => window.confirm(`Ngắt kết nối ${p.name} trên máy này? Dữ liệu trên ổ vẫn giữ.`) && run(api.cloudDisconnect(p.id).then(setCloud))}>
                  Ngắt kết nối
                </button>
              ) : cloud?.connecting === p.id ? (
                <button className="btn" onClick={() => run(api.cloudCancelConnect())}>
                  Hủy
                </button>
              ) : p.available ? (
                <button className="btn btn-primary" disabled={busy} onClick={() => connect(p.id)}>
                  Kết nối
                </button>
              ) : (
                <span className="cloud-provider-soon">{p.id === 'gdrive' ? 'Sắp có' : 'Chưa dùng được'}</span>
              )}
            </div>
          ))}
          {cloud?.connecting && (
            <div className="cloud-note">
              <span className="codicon codicon-loading codicon-modifier-spin" /> Đang chờ bạn đăng nhập trong trình duyệt…
              {loginUrl && (
                <a href={loginUrl} target="_blank" rel="noreferrer">
                  Mở lại trang đăng nhập
                </a>
              )}
            </div>
          )}

          <div className="cloud-section-title">Thư mục «{info?.name}»</div>
          {folder ? (
            <>
              <div className="cloud-folder-line">
                Đồng bộ lên <b>{folderProvider?.name ?? folder.provider}</b> · thư mục «{folder.remoteName}»
              </div>
              <div className={`cloud-status ${cloudBadge(cloud).tone}`}>
                <span className={`codicon ${cloud?.sync.state === 'syncing' ? 'codicon-loading codicon-modifier-spin' : cloudBadge(cloud).icon}`} />
                {syncLine(cloud!.sync)}
              </div>
              {!folderProvider?.account && <div className="cloud-note is-warn">Máy này chưa kết nối {folderProvider?.name ?? folder.provider}: kết nối ở trên để đồng bộ.</div>}
              <div className="cloud-actions">
                <button className="btn btn-primary" disabled={busy || cloud?.sync.state === 'syncing' || !folderProvider?.account} onClick={() => run(api.cloudSync().then(setCloud))}>
                  <span className="codicon codicon-sync" /> Đồng bộ ngay
                </button>
                <button className="btn" disabled={busy} onClick={() => window.confirm('Tắt đồng bộ thư mục này? Dữ liệu đã đẩy lên ổ vẫn giữ.') && run(api.cloudFolder(false).then(setCloud))}>
                  Tắt đồng bộ
                </button>
              </div>
            </>
          ) : connected.length ? (
            <div className="cloud-actions">
              {connected.map((p) => (
                <button key={p.id} className="btn btn-primary" disabled={busy} onClick={() => run(api.cloudFolder(true, p.id).then(setCloud))}>
                  <span className="codicon codicon-cloud-upload" /> Đồng bộ lên {p.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="cloud-note">Kết nối một tài khoản ở trên để bật đồng bộ cho thư mục này.</div>
          )}
          {error && <div className="sidebar-message is-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}
