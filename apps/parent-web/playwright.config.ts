import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', workers: 1, timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:5174', viewport: { width: 1440, height: 1000 } },
  webServer: [
    { command: '../server/.venv/bin/python tests/serve.py', url: 'http://127.0.0.1:8098/healthz', reuseExistingServer: false },
    { command: 'MOLLY_API_PROXY=http://127.0.0.1:8098 pnpm dev', url: 'http://127.0.0.1:5174/manage/', reuseExistingServer: false },
  ] });
