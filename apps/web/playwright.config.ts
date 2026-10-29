import { defineConfig } from '@playwright/test';
const webPort = process.env.MOLLYTIME_WEB_E2E_PORT || '5174';
const apiPort = process.env.MOLLYTIME_E2E_PORT || '8098';
export default defineConfig({ testDir: './tests', testIgnore: '**/pwa-production.spec.ts', workers: 1, timeout: 60000,
  use: { baseURL: `http://127.0.0.1:${webPort}`, viewport: { width: 1440, height: 1000 } },
  webServer: [
    { command: '../server/.venv/bin/python tests/serve.py', url: `http://127.0.0.1:${apiPort}/healthz`, reuseExistingServer: false },
    { command: `MOLLYTIME_API_PROXY=http://127.0.0.1:${apiPort} pnpm dev --port ${webPort}`, url: `http://127.0.0.1:${webPort}/manage/`, reuseExistingServer: false },
  ] });
