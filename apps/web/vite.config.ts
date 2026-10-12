import { defineConfig } from 'vite';
export default defineConfig({ base: '/manage/', build: { target: 'chrome90' },
  server: { proxy: { '/api': { target: process.env.MOLLY_API_PROXY || 'http://127.0.0.1:8096', changeOrigin: false } } } });
