import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProfile, parseFrontmatter } from '../src/profile.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function makeProfile(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ho-so-'));
  dir = root;
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

describe('hồ sơ Claude', () => {
  it('đọc frontmatter', () => {
    const { data, body } = parseFrontmatter('---\nname: reviewer\ntools: Read, Bash\nkeep: "true"\n---\nNội dung');
    expect(data).toEqual({ name: 'reviewer', tools: 'Read, Bash', keep: 'true' });
    expect(body).toBe('Nội dung');
  });

  it('ghép giọng trả lời, quy trình và subagent', () => {
    const p = loadProfile(
      makeProfile({
        'CLAUDE.md': '<!-- hướng dẫn điền -->\n# Quy trình\n\n## Bước 1\nKiểm tra dữ liệu.',
        '.claude/output-styles/nha-khoa-hoc.md': '---\nname: Nhà khoa học\ndescription: x\n---\nTrả lời như cộng sự.',
        '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: Phản biện độc lập\ntools: Read, Grep, Glob, Bash\n---\nBạn là người phản biện.',
        '.claude/agents/thieu-mo-ta.md': '---\nname: hong\n---\nKhông có description nên bỏ qua.',
      }),
    )!;
    expect(p.info).toMatchObject({ outputStyle: 'Nhà khoa học', hasInstructions: true, agents: [{ name: 'reviewer' }] });
    expect(p.agents).toEqual({
      reviewer: { description: 'Phản biện độc lập', prompt: 'Bạn là người phản biện.', tools: ['Read', 'Grep', 'Glob', 'Bash'] },
    });
    // Tiêu đề trong file gốc bị hạ một cấp; chú thích HTML bị bỏ.
    expect(p.systemAppend).toContain('# Quy trình làm việc chung\n\n## Quy trình\n\n### Bước 1');
    expect(p.systemAppend).not.toContain('hướng dẫn điền');
    expect(p.systemAppend.indexOf('Trả lời như cộng sự')).toBeLessThan(p.systemAppend.indexOf('Kiểm tra dữ liệu'));
    // Điều chỉnh cho app đặt cuối, thay cho mục Git.
    expect(p.systemAppend.trimEnd()).toMatch(/Không dùng git[\s\S]*phản biện áp dụng cho phân tích[^\n]*$/);
  });

  it('không có thư mục hoặc thư mục trống thì không dùng hồ sơ', () => {
    expect(loadProfile(null)).toBeNull();
    expect(loadProfile(path.join(tmpdir(), 'khong-co-thu-muc-nay'))).toBeNull();
    expect(loadProfile(makeProfile({ 'ghi-chu.txt': 'x' }))).toBeNull();
  });
});
