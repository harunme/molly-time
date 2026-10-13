import { test, expect } from '@playwright/test';

test('OSS covers load directly and fall back to the server when unavailable', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify({
    accessToken: 'presentation-access', refreshToken: 'presentation-refresh', deviceId: 'device', childId: 'child',
  })));
  const direct = (name: string) => `https://covers.oss-cn-test.aliyuncs.com/${name}.jpg?OSSAccessKeyId=id&Expires=1&Signature=sig`;
  const serverRequests: string[] = [];
  await page.route('**/api/me', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/families/me/children', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/home**', (route) => route.fulfill({ json: { rows: [{ title: '媒体库', items: [
    { id: 'direct', name: '直连封面', image: { url: '/api/items/direct/image', directUrl: direct('direct') } },
    { id: 'fallback', name: '回退封面', image: { url: '/api/items/fallback/image', directUrl: direct('fallback') } },
  ] }] } }));
  await page.route('**/api/items/*/image?*', (route) => {
    serverRequests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" />' });
  });
  await page.route('https://covers.oss-cn-test.aliyuncs.com/**', (route) =>
    route.request().url().includes('/fallback.jpg')
      ? route.fulfill({ status: 403 })
      : route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" />' }));
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-direct"] .cover img')).toBeVisible();
  await expect(page.locator('[data-focus="series-fallback"] .cover img')).toBeVisible();
  expect(serverRequests).toEqual(['/api/items/fallback/image']);
});
