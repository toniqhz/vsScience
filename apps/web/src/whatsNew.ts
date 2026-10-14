import changelog from '../../../CHANGELOG.md?raw';

/** Một phiên bản trong CHANGELOG.md (mục "## 0.1.16 — 2026-10-15"). */
export interface ReleaseNote {
  version: string;
  date: string;
  /** Nội dung Markdown của mục. */
  body: string;
}

/** So phiên bản dạng 1.2.3; > 0 nếu a mới hơn b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function parseChangelog(md: string): ReleaseNote[] {
  const out: ReleaseNote[] = [];
  const parts = md.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    const m = /^v?(\d+(?:\.\d+)+)\s*(?:[—–-]\s*(.+))?$/.exec(head);
    if (!m) continue;
    out.push({ version: m[1]!, date: (m[2] ?? '').trim(), body: nl < 0 ? '' : part.slice(nl + 1).trim() });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

export const RELEASE_NOTES = parseChangelog(changelog);

/** Các bản mới hơn `from` (không tính) tới `to` (tính), mới nhất trước. */
export function notesBetween(from: string, to: string, notes = RELEASE_NOTES): ReleaseNote[] {
  return notes.filter((n) => compareVersions(n.version, from) > 0 && compareVersions(n.version, to) <= 0);
}
