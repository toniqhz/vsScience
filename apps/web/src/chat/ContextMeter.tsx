import type { ContextUsage } from '@ide/shared';
import { formatTokens } from './models';

/** Mức đầy của cửa sổ ngữ cảnh: vàng từ 70%, đỏ từ 90% (nên /compact). */
export function contextLevel(used: number, total: number): 'ok' | 'warn' | 'full' {
  const ratio = total ? used / total : 0;
  return ratio >= 0.9 ? 'full' : ratio >= 0.7 ? 'warn' : 'ok';
}

export function ContextRing({ used, total, size = 14 }: { used: number; total: number; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const ratio = total ? Math.min(used / total, 1) : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={`context-ring level-${contextLevel(used, total)}`}>
      <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="ring-fill"
        strokeDasharray={`${c * ratio} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/** Nút nhỏ trên thanh công cụ: vòng tròn + phần trăm. */
export function ContextMeter({ used, total, onClick }: { used: number; total: number; onClick: () => void }) {
  const pct = total ? Math.round((used / total) * 100) : 0;
  return (
    <button
      className={`composer-chip context-meter level-${contextLevel(used, total)}`}
      title={`Ngữ cảnh đã dùng: ${formatTokens(used)} / ${formatTokens(total)} token (${pct}%)`}
      onClick={onClick}
    >
      <ContextRing used={used} total={total} />
      <span className="meter-label">{pct}%</span>
    </button>
  );
}

const CATEGORY_LABEL: Record<string, string> = {
  'System prompt': 'Hướng dẫn hệ thống',
  'System tools': 'Công cụ',
  'MCP tools': 'Công cụ kết nối',
  'MCP server instructions': 'Hướng dẫn kết nối',
  'Custom agents': 'Trợ lý phụ',
  'Memory files': 'Ghi nhớ',
  Skills: 'Kỹ năng',
  Messages: 'Hội thoại',
};

/** Thẻ chi tiết hiện trong hội thoại khi gõ /context (số liệu từ Agent SDK). */
export function ContextCard({
  usage,
  modelName,
  fallbackMax,
}: {
  usage: ContextUsage | null;
  modelName: string;
  fallbackMax: number;
}) {
  const used = usage?.used ?? 0;
  const total = usage?.max ?? fallbackMax;
  const pct = total ? (used / total) * 100 : 0;
  const level = contextLevel(used, total);
  return (
    <div className="context-card">
      <div className="context-card-head">
        <ContextRing used={used} total={total} size={18} />
        <strong>Cửa sổ ngữ cảnh</strong>
        <span className="context-card-model">{modelName}</span>
      </div>
      <div className={`context-bar level-${level}`}>
        <div style={{ width: `${Math.max(pct, used ? 1 : 0)}%` }} />
      </div>
      <div className="context-card-numbers">
        <span>
          Đã dùng <strong>{formatTokens(used)}</strong> ({pct.toFixed(pct && pct < 1 ? 1 : 0)}%)
        </span>
        <span>Còn trống {formatTokens(Math.max(total - used, 0))}</span>
        <span>Tối đa {formatTokens(total)}</span>
      </div>
      {usage && usage.categories.length > 0 && (
        <div className="context-categories">
          {usage.categories.map((c) => (
            <div key={c.name} className="context-category">
              <span>{CATEGORY_LABEL[c.name] ?? c.name}</span>
              <span>{formatTokens(c.tokens)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="context-card-hint">
        {!usage
          ? 'Chưa có hội thoại nào chiếm ngữ cảnh.'
          : level === 'ok'
            ? 'Còn nhiều chỗ trống.'
            : 'Ngữ cảnh sắp đầy — gõ /compact để tóm gọn hội thoại.'}
      </p>
    </div>
  );
}
