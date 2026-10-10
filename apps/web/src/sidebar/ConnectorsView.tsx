import { useEffect, useState } from 'react';
import type { ConnectorInfo } from '@ide/shared';
import { api } from '../api/client';

const SETTINGS_URL = 'https://claude.ai/settings/connectors';

const STATUS: Record<ConnectorInfo['status'], { label: string; cls: string }> = {
  connected: { label: 'Đã kết nối', cls: 'is-ok' },
  'needs-auth': { label: 'Chưa kết nối', cls: 'is-warn' },
  failed: { label: 'Lỗi kết nối', cls: 'is-error' },
  pending: { label: 'Đang kết nối…', cls: 'is-pending' },
  disabled: { label: 'Đang tắt', cls: 'is-off' },
};

const ORDER: ConnectorInfo['status'][] = ['connected', 'pending', 'needs-auth', 'failed', 'disabled'];

function sourceLabel(source?: string): string {
  if (source === 'claudeai') return 'claude.ai';
  if (source === 'user') return 'trên máy';
  if (source === 'project' || source === 'local') return 'của thư mục';
  if (source === 'plugin') return 'plugin';
  return source ?? '';
}

function ConnectorRow({ c, onReconnect, busy }: { c: ConnectorInfo; onReconnect: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[c.status];
  const readOnly = c.tools.filter((t) => t.readOnly).length;
  return (
    <div className="connector">
      <button className="side-row connector-row" onClick={() => setOpen((v) => !v)} title={c.error ?? c.key}>
        <span className={`codicon codicon-chevron-${open ? 'down' : 'right'} search-chevron`} />
        <span className={`connector-dot ${st.cls}`} />
        <span className="side-row-name">{c.name}</span>
        <span className="side-row-dir">
          {st.label}
          {c.status === 'connected' && c.tools.length > 0 && ` · ${c.tools.length} công cụ`}
        </span>
      </button>
      {open && (
        <div className="connector-body">
          <div className="connector-meta">Nguồn: {sourceLabel(c.source)}</div>
          {c.status === 'needs-auth' && (
            <div className="connector-hint">
              Cần cấp quyền trên claude.ai: mở Cài đặt → Connectors, bấm <strong>Connect</strong> ở {c.name}, rồi quay lại bấm “Kiểm tra lại”.
            </div>
          )}
          {c.error && <div className="connector-hint is-error">{c.error}</div>}
          {c.status !== 'connected' && (
            <div className="connector-actions">
              {c.source === 'claudeai' && (
                <a className="btn" href={SETTINGS_URL} target="_blank" rel="noreferrer">
                  <span className="codicon codicon-link-external" /> Kết nối trên claude.ai
                </a>
              )}
              <button className="btn" disabled={busy} onClick={onReconnect}>
                Kiểm tra lại
              </button>
            </div>
          )}
          {c.tools.length > 0 && (
            <>
              <div className="connector-meta">
                {readOnly > 0 ? `${readOnly} công cụ chỉ đọc (tra cứu) — Claude dùng không cần hỏi.` : 'Claude sẽ hỏi trước khi dùng các công cụ này.'}
              </div>
              {c.tools.map((t) => (
                <div key={t.name} className="connector-tool" title={t.description}>
                  <span className="codicon codicon-tools" />
                  <span className="connector-tool-name">{t.name}</span>
                  {t.readOnly && <span className="connector-tag">chỉ đọc</span>}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Connector Claude dùng được trong app: của tài khoản claude.ai (Consensus, Scite, Claude Docs…) và cấu hình trên máy. */
export function ConnectorsView() {
  const [items, setItems] = useState<ConnectorInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (refresh: boolean) => {
    setBusy(true);
    api
      .connectors(refresh)
      .then((c) => (setItems(c), setError(null)))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(false), []);

  const reconnect = (key: string) => {
    setBusy(true);
    api
      .reconnectConnector(key)
      .then((c) => setItems(c))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const sorted = [...(items ?? [])].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name, 'vi'));
  const connected = sorted.filter((c) => c.status === 'connected').length;

  return (
    <div className="explorer">
      <div className="explorer-title">
        <span className="sidebar-title">Connector</span>
        <button className="icon-btn" title="Kiểm tra lại" disabled={busy} onClick={() => load(true)}>
          <span className={`codicon ${busy ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh'}`} />
        </button>
      </div>
      <div className="side-list">
        {error && <div className="side-count is-error">{error}</div>}
        {!items && !error && <div className="side-count">Đang kiểm tra connector… (lần đầu mất vài giây)</div>}
        {items && (
          <div className="side-count">
            {items.length === 0
              ? 'Chưa có connector nào. Thêm connector (Consensus, Scite, PubMed…) ở claude.ai → Settings → Connectors.'
              : `${connected}/${items.length} connector đã kết nối. Claude dùng connector khoa học để tìm bài báo và ghi rõ nguồn trích dẫn.`}
          </div>
        )}
        {sorted.map((c) => (
          <ConnectorRow key={c.key} c={c} busy={busy} onReconnect={() => reconnect(c.key)} />
        ))}
        {items && (
          <div className="connector-footer">
            <a className="btn" href={SETTINGS_URL} target="_blank" rel="noreferrer">
              <span className="codicon codicon-link-external" /> Thêm, kết nối trên claude.ai
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
