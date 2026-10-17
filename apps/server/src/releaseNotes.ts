/**
 * Ghi chú "Có gì mới" của các bản chưa cài, lấy từ GitHub Releases (workflow phát hành chép mục của
 * CHANGELOG.md vào đầu trang Release, dưới tiêu đề "## Có gì mới"). App đóng sẵn ghi chú của các bản đã
 * cài; bản tương lai thì chỉ có trên GitHub.
 */

const RELEASES_URL = 'https://api.github.com/repos/toniqhz/vsScience/releases?per_page=30';
const CACHE_MS = 10 * 60_000;

export interface ReleaseNote {
  version: string;
  /** Ngày phát hành dạng 2026-10-14. */
  date: string;
  body: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Phần "## Có gì mới" của nội dung trang Release (tới tiêu đề "## " kế tiếp). */
export function whatsNewSection(body: string): string {
  const m = /^## Có gì mới\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(body.replace(/\r\n/g, '\n'));
  return m ? m[1]!.trim() : '';
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

let cache: { at: number; releases: { tag_name: string; published_at: string | null; body: string | null; draft: boolean }[] } | null = null;

/** Các bản mới hơn `current` tới `latest` (tính), mới nhất trước. */
export async function releaseNotesBetween(current: string, latest: string, fetchFn: FetchFn = fetch): Promise<ReleaseNote[]> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const res = await fetchFn(RELEASES_URL, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'VsScience' } });
    if (!res.ok) throw new Error(`GitHub trả lỗi ${res.status}`);
    cache = { at: Date.now(), releases: (await res.json()) as NonNullable<typeof cache>['releases'] };
  }
  return cache.releases
    .filter((r) => !r.draft)
    .map((r) => ({ version: r.tag_name.replace(/^v/, ''), date: (r.published_at ?? '').slice(0, 10), body: whatsNewSection(r.body ?? '') }))
    .filter((n) => n.body && compareVersions(n.version, current) > 0 && compareVersions(n.version, latest) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** Test: xóa bộ nhớ đệm. */
export function clearReleaseNotesCache() {
  cache = null;
}
