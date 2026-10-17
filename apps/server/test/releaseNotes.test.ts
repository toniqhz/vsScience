import { afterEach, describe, expect, it } from 'vitest';
import { clearReleaseNotesCache, releaseNotesBetween, whatsNewSection } from '../src/releaseNotes.js';

const body = (v: string) => `## Có gì mới\n\n- Tính năng của ${v}\n\n## Tải về\n\n| Máy | File |\n|---|---|\n`;
const fakeFetch = async () =>
  new Response(
    JSON.stringify([
      { tag_name: 'v0.1.18', published_at: '2026-10-20T01:00:00Z', body: body('0.1.18'), draft: true },
      { tag_name: 'v0.1.17', published_at: '2026-10-14T03:00:00Z', body: body('0.1.17'), draft: false },
      { tag_name: 'v0.1.16', published_at: '2026-10-14T01:00:00Z', body: body('0.1.16'), draft: false },
      { tag_name: 'v0.1.15', published_at: '2026-10-13T01:00:00Z', body: '## Tải về\n\nkhông có ghi chú', draft: false },
    ]),
  );

afterEach(() => clearReleaseNotesCache());

describe('ghi chú bản mới từ GitHub Releases', () => {
  it('chỉ lấy mục "Có gì mới", bỏ phần tải về', () => {
    expect(whatsNewSection(body('0.1.17'))).toBe('- Tính năng của 0.1.17');
    expect(whatsNewSection('## Tải về\n\nx')).toBe('');
    expect(whatsNewSection('## Có gì mới\n\n- chỉ có mục này')).toBe('- chỉ có mục này');
  });

  it('các bản mới hơn bản đang dùng tới bản mới nhất, mới nhất trước; bỏ bản nháp và bản không có ghi chú', async () => {
    const notes = await releaseNotesBetween('0.1.15', '0.1.17', fakeFetch);
    expect(notes).toEqual([
      { version: '0.1.17', date: '2026-10-14', body: '- Tính năng của 0.1.17' },
      { version: '0.1.16', date: '2026-10-14', body: '- Tính năng của 0.1.16' },
    ]);
  });
});
