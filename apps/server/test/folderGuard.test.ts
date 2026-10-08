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

  it('khóa PDF trong code Python ("/XObject", "/Width") không phải đường dẫn', () => {
    const code = `python3 -I -c "
import pypdf
r = pypdf.PdfReader('Sách/a.pdf')
xo = r.pages[0]['/Resources'].get('/XObject')
for k in xo:
    o = xo[k].get_object()
    if o.get('/Subtype') == '/Image': print(o.get('/Filter'), o.get('/Width'), o.get('/Height'))
"`;
    expect(bash(code)).toEqual([]);
    // Thư mục gốc có thật vẫn bị kiểm tra như cũ.
    expect(bash('ls /etc/')).toEqual(['/etc']);
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

  it('lệnh cài phần mềm luôn phải hỏi, dù không có đường dẫn', () => {
    for (const cmd of ['pip3 install pandas openpyxl -q', 'python3 -m pip install openpyxl', 'cd x && npm install -g foo', 'brew install libreoffice']) {
      expect(bash(cmd)).toEqual(['Cài phần mềm hoặc thư viện lên máy']);
    }
    expect(bash('python3 -c "import openpyxl"')).toEqual([]);
    expect(bash('pip list')).toEqual([]);
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


describe('FolderGuard trên Windows (PowerShell)', () => {
  const WIN_WS = 'C:\\Users\\Tuan Nguyen\\OneDrive\\Desktop\\cham thi';
  const env = {
    SystemRoot: 'C:\\WINDOWS',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    USERPROFILE: 'C:\\Users\\Tuan Nguyen',
    TEMP: 'C:\\Users\\TUANNG~1\\AppData\\Local\\Temp',
    APPDATA: 'C:\\Users\\Tuan Nguyen\\AppData\\Roaming',
  };
  const PY = 'C:\\Users\\Tuan Nguyen\\AppData\\Local\\Programs\\VsScience\\resources\\python';
  const scratch = claudeScratchRoot(WIN_WS, 'win32', env.TEMP);
  const g = new FolderGuard(() => [WIN_WS, scratch], { platform: 'win32', env, home: env.USERPROFILE, extraAllowed: [PY] });
  const ps = (command: string) => g.outside('PowerShell', { command }, WIN_WS);

  it('scratchpad của Claude Code trên Windows', () => {
    expect(scratch).toBe('C:\\Users\\TUANNG~1\\AppData\\Local\\Temp\\claude\\C--Users-Tuan-Nguyen-OneDrive-Desktop-cham-thi');
    expect(claudeScratchRoot('C:\\' + 'a'.repeat(300), 'win32', 'C:\\T')).toMatch(/^C:\\T\\claude\\C--a{197}-\*$/);
  });

  it('lệnh trong thư mục làm việc, scratchpad, Python đi kèm: không cần hỏi', () => {
    expect(ps(`python "${scratch}\\phien-1\\scratchpad\\cham.py" "Bài làm\\An.docx"`)).toEqual([]);
    expect(ps(`& "${PY}\\python.exe" -c "import docx; print(docx.Document('Đề thi/Đề 1.docx').paragraphs[0].text)"`)).toEqual([]);
    expect(ps(`Get-ChildItem -Path "${WIN_WS}\\Bài làm" -Filter *.docx | Select-Object Name`)).toEqual([]);
    expect(ps('Get-ChildItem . -Recurse -Include *.xlsx; $x = 10 / 2; Write-Output "Xong`n"')).toEqual([]);
    expect(ps('cmd /c dir /s /b *.pdf')).toEqual([]);
    expect(ps(`Copy-Item "Đề thi\\Đề 1.docx" "$env:TEMP\\claude\\C--Users-Tuan-Nguyen-OneDrive-Desktop-cham-thi\\s\\scratchpad\\"`)).toEqual([]);
    expect(ps('& "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE" /q')).toEqual([]);
  });

  it('PowerShell: py -m pip install, winget install, Install-Module cũng phải hỏi', () => {
    expect(ps('py -m pip install openpyxl')).toEqual(['Cài phần mềm hoặc thư viện lên máy']);
    expect(ps('winget install LibreOffice')).toEqual(['Cài phần mềm hoặc thư viện lên máy']);
    expect(ps('Install-Module ImportExcel -Scope CurrentUser')).toEqual(['Cài phần mềm hoặc thư viện lên máy']);
  });

  it('đụng tới file ngoài thư mục: báo đường dẫn để hỏi lại', () => {
    expect(ps('Get-Content "$env:USERPROFILE\\Documents\\mat-khau.txt"')).toEqual(['C:\\Users\\Tuan Nguyen\\Documents\\mat-khau.txt']);
    expect(ps('Remove-Item -Recurse ~\\Desktop\\*')).toEqual(['C:\\Users\\Tuan Nguyen\\Desktop']);
    expect(ps('Copy-Item "Đề thi\\Đề 1.docx" ..\\khac\\')).toEqual(['C:\\Users\\Tuan Nguyen\\OneDrive\\Desktop\\khac']);
    expect(ps('type %APPDATA%\\Claude\\config.json')).toEqual(['C:\\Users\\Tuan Nguyen\\AppData\\Roaming\\Claude\\config.json']);
    expect(ps('Get-ChildItem D:\\Tai lieu')).toEqual(['D:\\Tai']);
    expect(ps('Get-Content \\\\may-chu\\chia-se\\de.docx')).toEqual(['\\\\may-chu\\chia-se\\de.docx']);
  });

  it('không phân biệt hoa thường khi so đường dẫn Windows', () => {
    expect(ps('Get-Content "c:\\users\\tuan nguyen\\onedrive\\desktop\\CHAM THI\\de.docx"')).toEqual([]);
    expect(g.outside('Write', { file_path: 'C:\\USERS\\Tuan Nguyen\\OneDrive\\Desktop\\cham thi\\moi.docx' }, WIN_WS)).toEqual([]);
    expect(g.outside('Read', { file_path: 'C:\\Users\\Tuan Nguyen\\.ssh\\id_rsa' }, WIN_WS)).toEqual(['C:\\Users\\Tuan Nguyen\\.ssh\\id_rsa']);
  });

  it('hiện đường dẫn rút gọn bằng ~', () => {
    expect(g.display('C:\\Users\\Tuan Nguyen\\Documents\\a.txt')).toBe('~\\Documents\\a.txt');
  });
});
