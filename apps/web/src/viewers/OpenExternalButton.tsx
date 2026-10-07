import { useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * Nút mở file bằng Word/Excel trên máy để người dùng tự sửa. Lưu trong Word/Excel là
 * khung xem tự tải lại và mục Thay đổi tự ghi nhận (app theo dõi file trên đĩa).
 */
export function OpenExternalButton({ path, app, primary = false }: { path: string; app: 'Word' | 'Excel'; primary?: boolean }) {
  const [state, setState] = useState<'idle' | 'opening' | 'opened' | 'error'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    if (state !== 'opened' && state !== 'error') return;
    const t = window.setTimeout(() => setState('idle'), state === 'error' ? 6000 : 4000);
    return () => window.clearTimeout(t);
  }, [state]);

  const open = () => {
    setState('opening');
    api.openExternal(path).then(
      () => setState('opened'),
      (e: Error) => {
        setError(e.message);
        setState('error');
      },
    );
  };

  return (
    <span className="open-external">
      {state === 'opened' && <span className="open-external-note">Đang mở trong {app}… Lưu file là ở đây tự cập nhật.</span>}
      {state === 'error' && <span className="open-external-note is-error" title={error}>Không mở được: {error}</span>}
      <button
        className={`btn ${primary ? 'btn-primary' : ''}`}
        onClick={open}
        disabled={state === 'opening'}
        title={`Mở file bằng ${app} trên máy để tự sửa`}
      >
        <span className="codicon codicon-link-external" /> Mở bằng {app}
      </button>
    </span>
  );
}
