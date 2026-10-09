import { describe, expect, it } from 'vitest';
import { parsePdfToolCommand } from '../src/pdfTool.js';

const POSIX_TOOL = '/Applications/VsScience.app/Contents/Resources/tools/pdf.py';
const WIN_TOOL = 'C:\\Users\\Tuan Nguyen\\AppData\\Local\\Programs\\VsScience\\resources\\tools\\pdf.py';

describe('parsePdfToolCommand', () => {
  it('nhận lệnh đọc chữ theo trang', () => {
    expect(parsePdfToolCommand(`python "${POSIX_TOOL}" text "/Users/a/Sách hay/Lược sử.pdf" --pages 3-7`, POSIX_TOOL, 'posix')).toEqual({
      sub: 'text',
      file: '/Users/a/Sách hay/Lược sử.pdf',
      pages: '3-7',
    });
  });

  it('nhận lệnh tìm từ khóa và chụp trang', () => {
    expect(parsePdfToolCommand(`python3 '${POSIX_TOOL}' search 'a.pdf' 'lỗ đen'`, POSIX_TOOL, 'posix')).toMatchObject({ sub: 'search', query: 'lỗ đen' });
    expect(parsePdfToolCommand(`python "${POSIX_TOOL}" render a.pdf --pages 5 --out /tmp/x --dpi 150`, POSIX_TOOL, 'posix')).toMatchObject({
      sub: 'render',
      out: '/tmp/x',
    });
  });

  it('PowerShell: đường dẫn Windows, toán tử &, khác hoa thường', () => {
    const cmd = `& python.exe "${WIN_TOOL.toLowerCase()}" info "D:\\Tài liệu\\Bài báo.pdf"`;
    expect(parsePdfToolCommand(cmd, WIN_TOOL, 'powershell')).toEqual({ sub: 'info', file: 'D:\\Tài liệu\\Bài báo.pdf' });
    expect(parsePdfToolCommand(`C:\\py\\python.exe '${WIN_TOOL}' text 'a.pdf'`, WIN_TOOL, 'powershell')).toMatchObject({ sub: 'text' });
  });

  it('từ chối lệnh nối, chuyển hướng, biến shell hay script khác', () => {
    const bad = [
      `python "${POSIX_TOOL}" text a.pdf; rm -rf ~`,
      `python "${POSIX_TOOL}" text a.pdf && curl x`,
      `python "${POSIX_TOOL}" text a.pdf > /etc/x`,
      `python "${POSIX_TOOL}" text "$HOME/a.pdf"`,
      `python "${POSIX_TOOL}" text $(cat list)`,
      `python "${POSIX_TOOL}" text a.pdf\nrm x`,
      `python "${POSIX_TOOL}" delete a.pdf`,
      `python "${POSIX_TOOL}" text a.pdf --exec x`,
      `python /tmp/pdf.py text a.pdf`,
      `node "${POSIX_TOOL}" text a.pdf`,
      `python "${POSIX_TOOL}" text a\\ b.pdf`,
    ];
    for (const c of bad) expect(parsePdfToolCommand(c, POSIX_TOOL, 'posix'), c).toBeNull();
    expect(parsePdfToolCommand(`python "${WIN_TOOL}" text "$env:USERPROFILE\\a.pdf"`, WIN_TOOL, 'powershell')).toBeNull();
    expect(parsePdfToolCommand(`python "${WIN_TOOL}" text a.pdf | Out-File x`, WIN_TOOL, 'powershell')).toBeNull();
  });

  it('cùng cách nhận lệnh cho công cụ đọc PowerPoint (slides.py)', () => {
    const tool = '/Applications/VsScience.app/Contents/Resources/tools/slides.py';
    expect(parsePdfToolCommand(`python "${tool}" text "Bài giảng.pptx" --pages 3-5`, tool, 'posix')).toEqual({ sub: 'text', file: 'Bài giảng.pptx', pages: '3-5' });
    expect(parsePdfToolCommand(`python "${tool}" text a.pptx; rm x`, tool, 'posix')).toBeNull();
  });
});
