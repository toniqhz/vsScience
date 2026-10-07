import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FolderGuard, claudeScratchRoot, shellWords } from '../src/folderGuard.js';

const WS = '/mnt/c/Users/Tuan Nguyen/OneDrive/Desktop/cham thi';
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'nhap-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const guard = new FolderGuard(() => [WS, SCRATCH]);
const bash = (command: string) => guard.outside('Bash', { command }, WS);

describe('shellWords', () => {
  it('giữ nguyên đường dẫn có dấu cách trong nháy hoặc escape', () => {
    expect(shellWords(`ls "${WS}/Đề thi" && cat /a\\ b/c`)).toEqual(['ls', `${WS}/Đề thi`, 'cat', '/a b/c']);
  });
});

describe('FolderGuard', () => {
  it('lệnh chỉ dùng file trong thư mục làm việc và thư mục nháp: không cần hỏi', () => {
    expect(bash(`python3 -c "import docx; print(docx.Document('Đề thi/Đề 15 phút.docx').paragraphs[0].text)"`)).toEqual([]);
    expect(bash(`cd "${WS}" && ls -la "Bài làm/" | head -20`)).toEqual([]);
    expect(bash(`/usr/bin/python3 ${SCRATCH}/cham.py "${WS}/Bài làm/An.docx" > /dev/null 2>&1`)).toEqual([]);
    expect(bash(`python3 - <<'EOF'\nimport openpyxl\nwb = openpyxl.load_workbook("${WS}/Điểm.xlsx")\nprint(len(wb.sheetnames) / 2)\nEOF`)).toEqual([]);
    expect(bash('curl -s https://example.com/a/b | head')).toEqual([]);
  });

  it('đụng tới file ngoài thư mục: báo đường dẫn để hỏi lại', () => {
    expect(bash('cat ~/.ssh/id_rsa')).toEqual([path.join(homedir(), '.ssh/id_rsa')]);
    expect(bash('cp "Đề thi/Đề.docx" ../Desktop-khac/')).toEqual(['/mnt/c/Users/Tuan Nguyen/OneDrive/Desktop/Desktop-khac']);
    expect(bash('python3 /tmp/x.py')).toEqual(['/tmp/x.py']);
    expect(bash(`python3 - <<'EOF'\nopen("/home/ai-do/bi-mat.txt").read()\nEOF`)).toEqual(['/home/ai-do/bi-mat.txt']);
    expect(bash('rm -rf $HOME/Documents/*')).toEqual([path.join(homedir(), 'Documents')]);
  });

  it('đọc nội dung script trong thư mục nháp để tìm đường dẫn bên ngoài', () => {
    writeFileSync(path.join(SCRATCH, 'xu-ly.py'), 'import shutil\nshutil.copy("Điểm.xlsx", "/mnt/d/Sao lưu/Điểm.xlsx")\n');
    writeFileSync(path.join(SCRATCH, 'sach.py'), 'print(open("Điểm.xlsx").read())\n');
    expect(bash(`python3 ${SCRATCH}/xu-ly.py`)).toEqual(['/mnt/d/Sao lưu/Điểm.xlsx']);
    expect(bash(`python3 ${SCRATCH}/sach.py`)).toEqual([]);
  });

  it('công cụ file: kiểm tra file_path / path', () => {
    expect(guard.outside('Edit', { file_path: `${WS}/Đề.docx` }, WS)).toEqual([]);
    expect(guard.outside('Write', { file_path: `${SCRATCH}/tam.py` }, WS)).toEqual([]);
    expect(guard.outside('Read', { file_path: '/etc/passwd' }, WS)).toEqual(['/etc/passwd']);
    expect(guard.outside('Grep', { pattern: 'x', path: '/home' }, WS)).toEqual(['/home']);
    expect(guard.outside('WebFetch', { url: 'https://a.b' }, WS)).toEqual([]);
  });
});

describe('claudeScratchRoot', () => {
  it('khớp cách Claude Code đặt tên thư mục scratchpad theo thư mục làm việc', () => {
    expect(path.basename(claudeScratchRoot(WS))).toBe('-mnt-c-Users-Tuan-Nguyen-OneDrive-Desktop-cham-thi');
    expect(path.dirname(claudeScratchRoot(WS))).toMatch(/\/claude-\d+$/);
  });
});

