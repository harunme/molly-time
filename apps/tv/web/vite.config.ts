import { defineConfig } from 'vite';
export default defineConfig({
  base: '/tv/',
  build: { target: 'chrome80' },
  server: { proxy: { '/api': process.env.MOLLY_API_PROXY || 'http://127.0.0.1:8096' } },
});
