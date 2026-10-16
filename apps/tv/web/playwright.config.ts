import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1920, height: 1080 } },
  webServer: { command: 'cd ../../.. && bash tools/run-tv-web.sh', url: 'http://127.0.0.1:5173/tv/', reuseExistingServer: !process.env.CI },
});
