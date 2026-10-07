import type { PlanUsage, UsageWindow } from '@ide/shared';

/** "lúc 19:50", "ngày mai 08:00", "Thứ Tư 9:00" hoặc "14/10 9:00". */
export function resetLabel(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  // Làm tròn tới phút gần nhất (12:49:59 → 12:50), như claude.ai.
  const at = new Date(Math.round(new Date(iso).getTime() / 60_000) * 60_000);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days <= 0) return `lúc ${time}`;
  if (days === 1) return `ngày mai ${time}`;
  if (days <= 7) {
    const weekday = at.toLocaleDateString('vi-VN', { weekday: 'long' });
    // Hạn mức tuần đặt lại đúng 7 ngày sau: cùng thứ với hôm nay, ghi "tuần sau" cho khỏi nhầm.
    return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}${days === 7 ? ' tuần sau' : ''} ${time}`;
  }
  return `${at.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })} ${time}`;
}

function level(percent: number): string {
  return percent >= 90 ? 'is-danger' : percent >= 75 ? 'is-warn' : '';
}

function Row({ label, w }: { label: string; w: UsageWindow }) {
  const pct = Math.round(w.percent);
  const reset = resetLabel(w.resetsAt);
  return (
    <div className="usage-row">
      <div className="usage-head">
        <span className="usage-label">{label}</span>
        <span className="usage-pct">{pct}%</span>
      </div>
      <div className="usage-line">
        <div className="usage-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
          <span className={level(pct)} style={{ width: `${pct}%` }} />
        </div>
        {reset && <span className="usage-reset">Đặt lại {reset}</span>}
      </div>
    </div>
  );
}

/** Hạn mức gói Claude.ai (phiên 5 giờ, tuần), giống mục Usage trên claude.ai. Bấm để cập nhật. */
export function UsageCard({ usage, onRefresh }: { usage: PlanUsage | null; onRefresh: () => void }) {
  if (!usage || (!usage.session && !usage.weekly)) return null;
  const updated = new Date(usage.updatedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  return (
    <button
      type="button"
      className="usage-card"
      onClick={onRefresh}
      title={`Hạn mức gói Claude${usage.plan ? ` ${usage.plan}` : ''} · cập nhật lúc ${updated} · bấm để cập nhật`}
    >
      {usage.session && <Row label="Phiên hiện tại" w={usage.session} />}
      {usage.weekly && <Row label="Tuần này" w={usage.weekly} />}
    </button>
  );
}
