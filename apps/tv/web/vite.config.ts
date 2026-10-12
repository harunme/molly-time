import { defineConfig } from 'vite';
export default defineConfig({
  base: '/tv/',
  build: { target: 'chrome80', emptyOutDir: true },
  server: { proxy: { '/api': { target: process.env.MOLLYTIME_API_PROXY || process.env.MOLLY_API_PROXY || 'http://127.0.0.1:8096', changeOrigin: true } } },
});
