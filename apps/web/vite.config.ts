import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = `http://127.0.0.1:${process.env.IDE_PORT ?? 4317}`;

export default defineConfig({
  plugins: [react()],
  // App chạy local, bundle lớn (pdf.js) không ảnh hưởng tốc độ tải.
  build: { chunkSizeWarningLimit: 2000 },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, ws: true },
    },
  },
});
