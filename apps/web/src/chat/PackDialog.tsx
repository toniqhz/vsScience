import { useEffect } from 'react';
import type { PackInfo } from '@ide/shared';
import { api } from '../api/client';

/** Gói đã hỏi người dùng (đồng ý hoặc "để sau") thì lần mở app sau không hỏi lại. */
export const packAskedKey = (id: string) => `ide.pack-asked.${id}`;

export function markPackAsked(id: string) {
  try {
    localStorage.setItem(packAskedKey(id), '1');
  } catch {
    // không lưu được thì lần sau hỏi lại — không sao
  }
}

export function wasPackAsked(id: string): boolean {
  try {
    return localStorage.getItem(packAskedKey(id)) === '1';
  } catch {
    return true; // không đọc được thì đừng làm phiền
  }
}

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** Gói này dùng để làm gì và khi nào không cần — nói bằng lời của người dùng, không thuật ngữ. */
const PURPOSE: Record<string, { uses: string[]; notNeeded: string }> = {
  data: {
    uses: [
      'Tính thống kê từ bảng điểm, số liệu khảo sát trong Excel/CSV: trung bình, độ lệch chuẩn, phân phối điểm.',
      'Kiểm định và so sánh (t-test, tương quan, khoảng tin cậy) theo quy trình lập luận khoa học.',
      'Vẽ biểu đồ (cột, đường, phân phối) và lưu thành ảnh để chèn vào báo cáo.',
      'Xử lý bảng số liệu lớn nhanh hơn.',
    ],
    notNeeded: 'Không cần nếu bạn chỉ đọc tài liệu, tóm tắt, soạn và sửa đề thi — những việc đó đã có sẵn.',
  },
};

/**
 * Hỏi người dùng có cài gói tùy chọn không (lần đầu mở app, hoặc lệnh /cai-goi). Nêu rõ mục đích,
 * dung lượng, nguồn tải. Đang cài vẫn đóng được, việc cài chạy tiếp ở nền.
 */
export function PackDialog({ pack, onClose }: { pack: PackInfo; onClose: () => void }) {
  const purpose = PURPOSE[pack.id];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const later = () => {
    markPackAsked(pack.id);
    onClose();
  };
  const install = () => {
    markPackAsked(pack.id);
    void api.installPack(pack.id).catch(() => {});
  };

  const pct = pack.progress?.total ? Math.round((pack.progress.done / pack.progress.total) * 100) : 0;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal pack-dialog" role="dialog" aria-label={pack.title}>
        <div className="modal-header">
          <span className="codicon codicon-graph pack-logo" />
          <span className="modal-title">
            {pack.state === 'installed' ? `${pack.title} đã cài` : `Cài thêm ${pack.title.toLowerCase()}?`}
          </span>
          <button className="icon-btn" title="Đóng" onClick={onClose}>
            <span className="codicon codicon-close" />
          </button>
        </div>
        <div className="pack-body">
          <p>Gói này giúp Claude:</p>
          {purpose && (
            <ul>
              {purpose.uses.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          )}
          {purpose && <p className="pack-muted">{purpose.notNeeded}</p>}
          <p className="pack-facts">
            <span className="codicon codicon-cloud-download" /> Tải về khoảng <strong>{mb(pack.downloadBytes)}</strong>, chiếm khoảng{' '}
            <strong>{mb(pack.installedBytes)}</strong> trên máy. Gồm {pack.packages.join(', ')}.
          </p>
          <p className="pack-muted">
            Tải từ kho thư viện Python chính thức (PyPI); mỗi file được kiểm tra mã băm trước khi cài. Không cài sẵn trong app để bộ cài nhẹ
            hơn. Có thể cài sau bất cứ lúc nào bằng lệnh <code>/cai-goi</code> trong ô chat.
          </p>
          {pack.state === 'installing' && (
            <div className="pack-progress">
              <div className="usage-bar">
                <span style={{ width: `${Math.max(pct, 4)}%` }} />
              </div>
              <span>{pack.message ?? 'Đang cài…'}</span>
            </div>
          )}
          {pack.state === 'error' && <div className="modal-error pack-error">{pack.message}</div>}
          {pack.state === 'installed' && (
            <p className="pack-done">
              <span className="codicon codicon-check" /> Đã cài xong. Từ tin nhắn tiếp theo, Claude dùng được các thư viện này.
            </p>
          )}
        </div>
        <div className="modal-footer">
          <span className="modal-footer-path" />
          {pack.state === 'installed' ? (
            <button className="btn btn-primary" onClick={onClose}>
              Xong
            </button>
          ) : pack.state === 'installing' ? (
            <button className="btn" onClick={onClose} title="Việc cài vẫn chạy tiếp ở nền">
              Ẩn, cài ở nền
            </button>
          ) : (
            <>
              <button className="btn" onClick={later}>
                Để sau
              </button>
              <button className="btn btn-primary" onClick={install}>
                {pack.state === 'error' ? 'Thử lại' : `Cài ngay (${mb(pack.downloadBytes)})`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
