import config from './playwright.config';
export default {
  ...config,
  use: { ...config.use, baseURL: 'http://127.0.0.1:5177' },
  webServer: [
    { command: 'MOLLYTIME_E2E_PORT=8099 ../server/.venv/bin/python tests/serve.py', url: 'http://127.0.0.1:8099/healthz', reuseExistingServer: false },
    { command: 'MOLLYTIME_API_PROXY=http://127.0.0.1:8099 pnpm dev --port 5177', url: 'http://127.0.0.1:5177/manage/', reuseExistingServer: false },
  ],
};
