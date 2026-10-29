import { expect, test, devices } from '@playwright/test';

test.use({ ...devices['Pixel 7'], defaultBrowserType: 'chromium' });
async function login(page: import('@playwright/test').Page) {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
}

test('phone navigation stays visible after scrolling and installation has usable instructions', async ({ page }) => {
  await login(page);
  const nav = page.getByRole('navigation', { name: '管理导航' });
  for (const link of await nav.getByRole('link').all()) {
    await expect(link).toBeInViewport();
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(nav.getByRole('link', { name: '资源库', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: '安装应用', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '安装 MollyTime' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/添加到主屏幕/).first()).toBeVisible();
  const close = dialog.getByRole('button', { name: '关闭', exact: true });
  await expect.poll(async () => (await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await close.click();
  await nav.getByRole('link', { name: '资源库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('phone-library.png') });
});

test('returning online reloads failed page data without navigating away', async ({ page, context }) => {
  await login(page);
  await context.setOffline(true);
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '资源库', exact: true }).click();
  await expect(page.getByText('网络已断开，恢复连接后自动重试。上传可能暂停。')).toBeVisible();
  await context.setOffline(false);
  await expect(page.locator('.resource-tile').first()).toBeVisible();
  await expect(page.locator('.page-content [role="alert"]')).toHaveCount(0);
});

test('long-press drag scrolls the library container to covers below the fold', async ({ page }) => {
  await login(page);
  const resource = (id: number) => ({ id: `phone-${id}`, name: `手机文件夹 ${id}`, type: 'Series', parentId: null, overview: '', status: 'draft', ready: false, runtimeMs: 0, imageUrl: '', files: [] });
  await page.route('**/api/manage/resources?*', route => {
    if (new URL(route.request().url()).searchParams.get('summary') === 'true') return route.continue();
    return route.fulfill({ json: { items: Array.from({ length: 20 }, (_, i) => resource(i)), total: 20, page: 1, pageSize: 20 } });
  });
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '资源库', exact: true }).click();
  const grid = page.locator('.resource-library-card > .resource-desktop');
  const cover = grid.getByRole('button', { name: '打开 手机文件夹 0', exact: true });
  await expect(cover).toBeVisible();
  const box = (await cover.boundingBox())!, area = (await grid.boundingBox())!;
  // Native touch input exercises the long-press path rather than a mouse drag.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
  await expect(page.locator('.desktop-drag-ghost')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width / 2, y: area.y + area.height - 20 }] });
  await expect.poll(() => grid.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.locator('.desktop-drag-ghost')).toHaveCount(0);
  await expect.poll(() => grid.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
});

test('dialogs follow the visible keyboard viewport and keep their close action reachable', async ({ page }) => {
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, { height: 800, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { value: viewport });
  });
  await login(page);
  await page.getByRole('button', { name: '安装应用', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '安装 MollyTime' });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 330, offsetTop: 60 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => {
    const box = (await dialog.boundingBox())!;
    return box.y >= 60 && box.y + box.height <= 390;
  }).toBe(true);
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('keyboard-visible-dialog.png') });
});
