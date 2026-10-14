import { defineConfig } from '@playwright/test';
const port = Number(process.env.MOLLYTIME_SITE_TEST_PORT ?? 4321);
export default defineConfig({
  testDir: './tests', workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1050 }, contextOptions: { reducedMotion: 'reduce' } },
  webServer: { command: `pnpm exec astro preview --host 127.0.0.1 --port ${port}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
