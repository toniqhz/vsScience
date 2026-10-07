// Gom tiến trình chính + toàn bộ server (Fastify, Agent SDK, isomorphic-git…) thành một file
// dist/main.mjs, để bản đóng gói không cần node_modules.
import { build } from 'esbuild';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

await build({
  entryPoints: [path.join(root, 'src/main.ts')],
  outfile: path.join(root, 'dist/main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  // electron có sẵn khi chạy; bufferutil/utf-8-validate là phần tăng tốc tùy chọn của ws.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  // Thư viện CommonJS gọi require() bên trong bundle ESM.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
