import { useEffect, useState } from 'react';
import type { UpdateInfo } from '@ide/shared';
import { api } from './api/client';
import { useWorkspace } from './api/workspace';

/** Mô tả ngắn trạng thái cập nhật (dùng cho hộp thoại, menu cài đặt, thanh trạng thái). */
export function updateSummary(u: UpdateInfo | null): string {
  if (!u) return 'Chỉ app desktop mới tự cập nhật.';
  switch (u.state) {
    case 'checking':
      return 'Đang kiểm tra bản mới…';
    case 'none':
      return `Bạn đang dùng bản mới nhất (${u.current}).`;
    case 'downloading':
      return `Đang tải bản ${u.latest ?? ''}${u.progress ? ` · ${u.progress}%` : ''}…`;
    case 'ready':
      return `Bản ${u.latest} đã tải xong — khởi động lại app để cập nhật.`;
    case 'available':
      return `Có bản mới ${u.latest} (đang dùng ${u.current}).`;
    case 'error':
      return `Không kiểm tra được bản mới: ${u.error ?? 'lỗi không rõ'}`;
    case 'unsupported':
      return u.error ?? 'Bản này không tự cập nhật.';
    default:
      return `Phiên bản ${u.current}.`;
  }
}

/** Kiểm tra cập nhật: bấm là kiểm tra ngay; Windows tải ngầm rồi khởi động lại để cài, Mac mở link tải bộ cài. */
export function UpdateDialog({ onClose }: { onClose: () => void }) {
  const { update } = useWorkspace();
  const [info, setInfo] = useState<UpdateInfo | null>(update);
  const [error, setError] = useState<string | null>(null);

  // Kiểm tra ngay khi mở hộp thoại; trạng thái sau đó cập nhật qua sự kiện từ server.
  useEffect(() => {
    api.checkUpdate().then(setInfo, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (update) setInfo(update);
  }, [update]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const busy = info?.state === 'checking' || info?.state === 'downloading';
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal confirm-dialog update-dialog" role="dialog" aria-label="Kiểm tra cập nhật">
        <div className="confirm-body">
          <span className={`codicon ${busy ? 'codicon-loading codicon-modifier-spin' : info?.state === 'ready' || info?.state === 'available' ? 'codicon-cloud-download' : 'codicon-check'} confirm-icon update-icon`} />
          <div>
            <div className="confirm-title">Cập nhật VsScience</div>
            <div className="confirm-detail">{error ?? updateSummary(info)}</div>
            {info?.state === 'downloading' && (
              <div className="update-progress">
                <span style={{ width: `${info.progress ?? 0}%` }} />
              </div>
            )}
            {info?.state === 'available' && !info.canInstall && (
              <div className="confirm-detail update-note">
                Bản này chưa tự cài được trên máy của bạn: tải bộ cài rồi cài đè lên bản cũ (dữ liệu và phiên làm việc giữ nguyên).
              </div>
            )}
          </div>
        </div>
        <div className="modal-footer confirm-footer">
          <button className="btn" onClick={onClose}>
            Đóng
          </button>
          {info?.state === 'ready' && (
            <button className="btn btn-primary" onClick={() => void api.installUpdate()}>
              Khởi động lại để cập nhật
            </button>
          )}
          {info?.state === 'available' && info.downloadUrl && (
            <a className="btn btn-primary" href={info.downloadUrl} target="_blank" rel="noreferrer">
              Tải bộ cài {info.latest}
            </a>
          )}
          {(info?.state === 'none' || info?.state === 'error') && (
            <button className="btn" onClick={() => api.checkUpdate().then(setInfo, (e: Error) => setError(e.message))}>
              Kiểm tra lại
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
