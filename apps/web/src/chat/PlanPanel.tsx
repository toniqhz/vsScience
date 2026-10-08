import { useState } from 'react';
import type { PlanStep } from './plan';

const OPEN_KEY = 'ide.chat.planOpen';

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

export function stepIcon(status: PlanStep['status']): string {
  return status === 'completed' ? 'codicon-pass-filled' : status === 'in_progress' ? 'codicon-circle-filled' : 'codicon-circle-large-outline';
}

/**
 * Kế hoạch đã thống nhất với Claude, ghim ở đầu khung chat: hội thoại dài đến đâu vẫn thấy
 * đang ở bước nào. Bấm vào một bước để cuộn tới chỗ bước đó được cập nhật gần nhất.
 */
export function PlanPanel({ steps, onJump, onClose }: { steps: PlanStep[]; onJump: (key: string) => void; onClose: () => void }) {
  const [open, setOpenState] = useState(loadOpen);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(OPEN_KEY, v ? '1' : '0');
    } catch {
      // chỉ là tiện ích, không lưu được cũng không sao
    }
  };
  if (steps.length === 0) return null;

  const done = steps.filter((s) => s.status === 'completed').length;
  const current = steps.find((s) => s.status === 'in_progress') ?? steps.find((s) => s.status === 'pending');
  const allDone = done === steps.length;

  return (
    <div className={`chat-column plan-panel ${open ? 'is-open' : ''}`}>
      <div className="plan-head-row">
        <button className="plan-head" onClick={() => setOpen(!open)} title={open ? 'Thu gọn kế hoạch' : 'Xem cả kế hoạch'}>
          <span className={`codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} />
          <span className="codicon codicon-checklist" />
          <span className="plan-title">Kế hoạch</span>
          <span className="plan-count">
            {done}/{steps.length} bước
          </span>
          <span className="plan-bar" aria-hidden>
            <span style={{ width: `${(done / steps.length) * 100}%` }} />
          </span>
          {!open && (
            <span className="plan-current">
              {allDone ? 'Đã xong tất cả' : current ? `Bước ${steps.indexOf(current) + 1}: ${current.subject}` : ''}
            </span>
          )}
        </button>
        <button className="plan-close" onClick={onClose} title="Đóng kế hoạch (hiện lại khi Claude lập kế hoạch mới)" aria-label="Đóng kế hoạch">
          <span className="codicon codicon-close" />
        </button>
      </div>
      {open && (
        <ol className="plan-steps">
          {steps.map((s, i) => (
            <li key={s.id}>
              <button className={`plan-step is-${s.status}`} onClick={() => onJump(s.key)} title="Xem chỗ này trong hội thoại">
                <span className={`codicon ${stepIcon(s.status)}`} />
                <span className="plan-step-n">{i + 1}.</span>
                <span className="plan-step-body">
                  <span className="plan-step-head">
                    <span className="plan-step-text">{s.subject}</span>
                    {s.status === 'in_progress' && <span className="plan-step-tag">đang làm</span>}
                  </span>
                  {s.description && <span className="plan-step-desc">{s.description}</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
