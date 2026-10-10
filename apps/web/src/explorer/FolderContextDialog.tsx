import { useEffect, useState } from 'react';
import type { FolderContext } from '@ide/shared';
import { api } from '../api/client';
import { useWorkspace } from '../api/workspace';

const FIELDS: { key: keyof FolderContext; label: string; placeholder: string; options?: string[]; multiline?: boolean }[] = [
  { key: 'topic', label: 'Chủ đề / môn học', placeholder: 'Ví dụ: Kỹ thuật chẩn đoán phân tử (BF4605)' },
  { key: 'audience', label: 'Người đọc', placeholder: 'Ví dụ: sinh viên năm 3 ngành Công nghệ sinh học; hội đồng chấm luận văn' },
  { key: 'purpose', label: 'Mục đích', placeholder: 'Ví dụ: ôn thi cuối kỳ; viết bài tổng quan; soạn đề kiểm tra' },
  { key: 'level', label: 'Mức độ học thuật', placeholder: 'Chọn hoặc gõ', options: ['Phổ thông', 'Đại học', 'Sau đại học', 'Chuyên gia / bài báo khoa học'] },
  { key: 'citationStyle', label: 'Chuẩn trích dẫn', placeholder: 'Chọn hoặc gõ', options: ['APA', 'Vancouver', 'Harvard', 'IEEE', 'Theo quy định của trường'] },
  { key: 'language', label: 'Ngôn ngữ viết', placeholder: 'Chọn hoặc gõ', options: ['Tiếng Việt', 'Tiếng Anh', 'Tiếng Việt, giữ thuật ngữ tiếng Anh trong ngoặc'] },
  { key: 'notes', label: 'Yêu cầu khác', placeholder: 'Ví dụ: bám sát giáo trình trong thư mục; đề trắc nghiệm 4 lựa chọn; thuật ngữ theo sách của Bộ…', multiline: true },
];

/**
 * Bối cảnh của thư mục đang mở: Claude đọc mỗi phiên (lưu trong CLAUDE.md của thư mục) để viết đúng người đọc,
 * đúng mức độ và đúng chuẩn trích dẫn mà không phải dặn lại.
 */
export function FolderContextDialog({ onClose }: { onClose: () => void }) {
  const { info } = useWorkspace();
  const [ctx, setCtx] = useState<FolderContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.folderContext().then(setCtx, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () => {
    if (!ctx) return;
    setBusy(true);
    api
      .saveFolderContext(ctx)
      .then(onClose)
      .catch((e: Error) => {
        setError(e.message);
        setBusy(false);
      });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal folder-context" role="dialog" aria-label="Bối cảnh thư mục">
        <div className="modal-header">
          <span className="codicon codicon-note" />
          <span className="modal-title">Bối cảnh thư mục · {info?.name}</span>
          <button className="icon-btn" title="Đóng (Esc)" onClick={onClose}>
            <span className="codicon codicon-close" />
          </button>
        </div>
        <div className="folder-context-body">
          <p className="folder-context-hint">
            Claude đọc phần này mỗi khi làm việc với thư mục, để viết đúng người đọc, đúng mức độ và đúng chuẩn trích dẫn. Lưu vào file
            CLAUDE.md của thư mục (phần bạn tự viết trong file đó được giữ nguyên). Để trống mục nào thì Claude tự chọn hoặc hỏi.
          </p>
          {!ctx && !error && <p className="folder-context-hint">Đang tải…</p>}
          {ctx &&
            FIELDS.map((f) => (
              <label key={f.key} className="folder-context-field">
                <span>{f.label}</span>
                {f.multiline ? (
                  <textarea
                    rows={3}
                    value={ctx[f.key]}
                    placeholder={f.placeholder}
                    onChange={(e) => setCtx({ ...ctx, [f.key]: e.target.value })}
                  />
                ) : (
                  <>
                    <input
                      value={ctx[f.key]}
                      placeholder={f.placeholder}
                      list={f.options ? `ctx-${f.key}` : undefined}
                      onChange={(e) => setCtx({ ...ctx, [f.key]: e.target.value })}
                    />
                    {f.options && (
                      <datalist id={`ctx-${f.key}`}>
                        {f.options.map((o) => (
                          <option key={o} value={o} />
                        ))}
                      </datalist>
                    )}
                  </>
                )}
              </label>
            ))}
        </div>
        {error && (
          <div className="modal-error">
            <span className="codicon codicon-error" /> {error}
          </div>
        )}
        <div className="modal-footer confirm-footer">
          <button className="btn" onClick={onClose}>
            Hủy
          </button>
          <button className="btn btn-primary" disabled={!ctx || busy} onClick={save}>
            Lưu bối cảnh
          </button>
        </div>
      </div>
    </div>
  );
}
