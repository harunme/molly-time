import { defineConfig } from '@playwright/test';
import config from './playwright.config';
const webPort = process.env.MOLLYTIME_WEB_E2E_PORT || '5174';
const apiPort = process.env.MOLLYTIME_E2E_PORT || '8098';
export default defineConfig({ ...config, testIgnore: [], testMatch: 'pwa-production.spec.ts', webServer: [
  { command: '../server/.venv/bin/python tests/serve.py', url: `http://127.0.0.1:${apiPort}/healthz`, reuseExistingServer: false },
  { command: `MOLLYTIME_API_PROXY=http://127.0.0.1:${apiPort} pnpm exec vite preview --host 127.0.0.1 --port ${webPort} --strictPort`, url: `http://127.0.0.1:${webPort}/manage/`, reuseExistingServer: false },
] });
