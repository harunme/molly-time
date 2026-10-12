import { defineConfig } from 'vite';
export default defineConfig({
  base: '/tv/',
  build: { target: 'chrome80' },
  server: { proxy: { '/api': 'http://127.0.0.1:8096' } },
});
