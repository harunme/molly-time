import { expect, test } from '@playwright/test';

const cases = [
  { path: 'library', endpoint: '/resources', selector: '.resource-skeleton-tile' },
  { path: 'trash', endpoint: '/trash', selector: '[data-slot="loading-skeleton"][data-variant="table"]' },
  { path: 'family', endpoint: '/settings', selector: '[data-slot="loading-skeleton"][data-variant="form"]' },
  { path: 'logs', endpoint: '/device-error-logs', selector: '[data-slot="loading-skeleton"]' },
  { path: 'operations/storage', endpoint: '/operations/storage', selector: '[data-slot="loading-skeleton"]' },
  { path: 'operations/backups', endpoint: '/operations/backups', selector: '[data-slot="loading-skeleton"]' },
  { path: 'operations/invitations', endpoint: '/operations/invitations', selector: '[data-slot="loading-skeleton"]' },
  { path: 'operations/client-releases', endpoint: '/operations/client-releases', selector: '[data-slot="loading-skeleton"]' },
  { path: 'operations/usage', endpoint: '/operations/usage', selector: '[data-slot="loading-skeleton"]' },
];

for (const { path, endpoint, selector } of cases) {
  test(`${path} shows a skeleton until data arrives`, async ({ page }) => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(url => url.pathname === `/api/manage${endpoint}`, async route => {
      await gate;
      await route.continue();
    });
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/manage/#/${path}`);
      await page.getByLabel('账号', { exact: true }).fill('operator@example.test');
      await page.getByLabel('密码', { exact: true }).fill('operator-e2e');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      const loading = page.locator(selector);
      await expect(loading.first()).toBeVisible();
      await expect(loading.first().locator('[data-slot="skeleton"]').first()).toBeVisible();
      await expect(page.locator('canvas')).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(loading.first().locator('[data-slot="skeleton"]').first()).toHaveCSS('animation-name', 'none');
      if (['library', 'trash', 'operations/storage'].includes(path)) {
        await page.screenshot({ path: `../../artifacts/skeleton-${path.replaceAll('/', '-')}-mobile.png`, animations: 'disabled' });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.screenshot({ path: `../../artifacts/skeleton-${path.replaceAll('/', '-')}-desktop.png`, animations: 'disabled' });
      }
      release();
      await expect(loading).toHaveCount(0);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

test('session checking uses a full page skeleton and request failures clear skeletons', async ({ page }) => {
  await page.goto('/manage/#/trash');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '回收站', exact: true })).toBeVisible();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/manage/auth/session', async route => { await gate; await route.continue(); });
  await page.route('**/api/manage/trash?*', route => route.fulfill({ status: 503, json: { detail: '暂时无法读取回收站' } }));
  try {
    await page.reload();
    await expect(page.locator('[data-slot="loading-skeleton"][data-variant="page"]')).toBeVisible();
    release();
    await expect(page.getByRole('alert')).toContainText('暂时无法读取回收站');
    await expect(page.locator('[data-slot="loading-skeleton"]')).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
