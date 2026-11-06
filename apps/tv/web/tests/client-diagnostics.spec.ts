import { test, expect } from '@playwright/test';

test('WebView exceptions use authenticated ingestion through the scoped bridge', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.diagnosticRequests = [];
    w.MollyBridge = { postMessage(raw: string) {
      const { id, method, args } = JSON.parse(raw);
      let result: unknown = { ok: true };
      if (method === 'getCapabilities') result = { bridgeVersion: 1, authenticated: true, nativePlayback: true,
        serverUrl: 'https://media.example.test', diagnosticsOwner: 'native-account-scope' };
      if (method === 'request' && args.path.split('?')[0] === '/api/home') result = { rows: [{ title: '媒体库', items: [{ id: 'story', name: '故事', episodeCount: 1 }] }] };
      if (method === 'request' && args.path === '/api/families/me/children') result = [];
      if (method === 'request' && args.path === '/api/client/error-logs') w.diagnosticRequests.push(args);
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
    } };
  });
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-story"]')).toBeVisible();
  await page.evaluate(() => {
    const error = new TypeError('private exception message');
    error.stack = 'TypeError: private exception message\n at render (https://private.example/tv/assets/tv.js:8:42?token=private)';
    window.dispatchEvent(new ErrorEvent('error', { error }));
  });
  await expect.poll(() => page.evaluate(() => (window as any).diagnosticRequests.length)).toBe(1);
  const request = await page.evaluate(() => (window as any).diagnosticRequests[0]);
  expect(request.method).toBe('POST'); expect(request.diagnosticsOwner).toBe('native-account-scope');
  expect(request.body.source).toBe('tv-web'); expect(request.body.errorType).toBe('TypeError');
  expect(request.body.stack).toEqual(['at render (tv.js:8:42)']);
  expect(JSON.stringify(request.body)).not.toContain('private');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mollytime.diagnostics.tv-web.v1') || '[]').length)).toBe(0);
});

test('browser TV reports use device authentication without putting credentials in the log', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify({
    accessToken: 'fixture-device-access', refreshToken: 'fixture-device-refresh', deviceId: 'fixture-tv',
  })));
  await page.route('**/api/me', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/families/me/children', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/home**', (route) => route.fulfill({ json: { rows: [{ title: '媒体库', items: [{ id: 'story', name: '故事', episodeCount: 1 }] }] } }));
  await page.route('**/api/client/error-logs', (route) => route.fulfill({ json: { ok: true } }));
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-story"]')).toBeVisible();
  const reported = page.waitForRequest('**/api/client/error-logs');
  await page.evaluate(() => window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
    promise: Promise.resolve(), reason: new Error('private rejection message'),
  })));
  const request = await reported;
  expect(request.headers().authorization).toBe('Bearer fixture-device-access');
  expect(request.postDataJSON().source).toBe('tv-web');
  expect(request.postDataJSON().code).toBe('JS_UNHANDLED_REJECTION');
  expect(request.postData()).not.toContain('fixture-device-access');
  expect(request.postData()).not.toContain('private rejection message');
});
