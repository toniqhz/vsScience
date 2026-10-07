// Chép cmaps, font chuẩn, wasm và ICC của pdf.js vào apps/web/public/pdfjs
// để pdf.js hiển thị đúng PDF dùng font CID (tiếng Việt, CJK) và ảnh JPX/JBIG2.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web');
const require = createRequire(path.join(webDir, 'package.json'));
const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
const { version } = JSON.parse(readFileSync(path.join(pdfjsDir, 'package.json'), 'utf8'));
const outDir = path.join(webDir, 'public/pdfjs');
const stamp = path.join(outDir, '.version');

if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version) process.exit(0);

mkdirSync(outDir, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const src = path.join(pdfjsDir, dir);
  if (existsSync(src)) cpSync(src, path.join(outDir, dir), { recursive: true });
}
writeFileSync(stamp, version);
console.log(`[pdfjs] đã chép tài nguyên pdf.js ${version} vào public/pdfjs`);
