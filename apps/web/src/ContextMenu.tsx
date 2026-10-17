import { useLayoutEffect, useRef, useState } from 'react';

export type ContextMenuItem =
  /** Dòng chỉ để xem (không bấm được), ví dụ tài khoản đang đăng nhập. */
  | { heading: string; icon: string; hint?: string }
  /** `checked`: mục bật/tắt, hiện công tắc và giữ menu mở khi bấm. */
  | { label: string; icon: string; danger?: boolean; hint?: string; checked?: boolean; /** Chấm vàng báo có điều mới. */ dot?: boolean; onClick: () => void }
  | 'separator';

/**
 * Menu chuột phải nổi tại vị trí con trỏ (giống VS Code). Đóng khi bấm ra ngoài, nhấn Esc,
 * cuộn hoặc đổi cỡ cửa sổ. Tự dịch vào trong nếu sát mép màn hình.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Tính lại khi menu đổi cỡ (mục nạp sau, ví dụ tài khoản Claude), để không tràn ra ngoài cửa sổ.
    const place = () => {
      const { width, height } = el.getBoundingClientRect();
      setPos({
        left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
        top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
      });
    };
    place();
    el.querySelector<HTMLButtonElement>('button')?.focus();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [x, y]);

  useLayoutEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const buttons = [...(ref.current?.querySelectorAll('button') ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    };
    const close = () => onClose();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('wheel', close);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="context-menu-sep" role="separator" />
        ) : 'heading' in item ? (
          <div key={i} className="context-menu-heading" title={item.hint ? `${item.heading} · ${item.hint}` : item.heading}>
            <span className={`codicon ${item.icon}`} />
            <span className="context-menu-label">{item.heading}</span>
            {item.hint && <span className="context-menu-hint">{item.hint}</span>}
          </div>
        ) : (
          <button
            key={i}
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            className={`context-menu-item ${item.danger ? 'is-danger' : ''}`}
            onClick={() => {
              if (item.checked === undefined) onClose();
              item.onClick();
            }}
          >
            <span className={`codicon ${item.icon}`} />
            <span className="context-menu-label">{item.label}</span>
            {item.dot && <span className="menu-dot" aria-label="Có bản mới" />}
            {item.hint && <span className="context-menu-hint">{item.hint}</span>}
            {item.checked !== undefined && <span className={`menu-switch ${item.checked ? 'is-on' : ''}`} aria-hidden="true" />}
          </button>
        ),
      )}
    </div>
  );
}
