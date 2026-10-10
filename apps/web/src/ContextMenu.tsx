import { useLayoutEffect, useRef, useState } from 'react';

export type ContextMenuItem =
  | { label: string; icon: string; danger?: boolean; hint?: string; onClick: () => void }
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
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
    el.querySelector<HTMLButtonElement>('button')?.focus();
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
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`context-menu-item ${item.danger ? 'is-danger' : ''}`}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            <span className={`codicon ${item.icon}`} />
            <span className="context-menu-label">{item.label}</span>
            {item.hint && <span className="context-menu-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
