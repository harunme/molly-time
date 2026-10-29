import { test, expect, devices, type Page } from '@playwright/test';
test.use({ ...devices['Pixel 7'], defaultBrowserType: 'chromium' });
async function login(page: Page) {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
}
test('native navigation and installation remain usable after scrolling', async ({ page }) => {
  await login(page);
  const nav = page.getByRole('navigation', { name: '手机导航' });
  await expect(nav.getByRole('link')).toHaveCount(4);
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  for (const link of await nav.getByRole('link').all()) { await expect(link).toBeInViewport(); expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44); }
  await nav.getByRole('link', { name: '家庭', exact: true }).click();
  await page.getByRole('button', { name: '安装应用', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '安装 MollyTime' });
  await expect(dialog).toBeVisible(); await expect(dialog.getByText(/添加到主屏幕/).first()).toBeVisible();
  await expect.poll(async () => (await dialog.getByRole('button', { name: '关闭', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
});
test('online recovery refreshes the native library without leaving it', async ({ page, context }) => {
  await login(page); await context.setOffline(true);
  await page.getByRole('navigation', { name: '手机导航' }).getByRole('link', { name: '内容', exact: true }).click();
  await expect(page.locator('.m-error')).toBeVisible();
  await context.setOffline(false); await expect(page.locator('.m-content-item').first()).toBeVisible(); await expect(page.locator('.m-error')).toHaveCount(0);
});
test('a touch swipe scrolls the document without opening an action sheet', async ({ page }) => {
  const folders = Array.from({ length: 20 }, (_, i) => ({ id: `swipe-${i}`, name: `故事 ${i}`, type: 'Series', parentId: null, status: 'draft', ready: false, imageUrl: '', files: [] }));
  await page.route('**/api/manage/resources?*', route => route.fulfill({ json: { items: folders, total: 20, page: 1, pageSize: 20 } }));
  await login(page); await page.getByRole('navigation', { name: '手机导航' }).getByRole('link', { name: '内容' }).click();
  await expect(page.locator('.m-content-item')).toHaveCount(20);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture', { x: 100, y: 600, yDistance: -400, gestureSourceType: 'touch' });
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(50);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.locator('.m-collection').evaluate(el => getComputedStyle(el).overflowY)).toBe('visible');
});
test('native sheets follow the visible keyboard viewport', async ({ page }) => {
  await page.addInitScript(() => { const viewport = new EventTarget(); Object.assign(viewport, { height: 800, width: innerWidth, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 }); Object.defineProperty(window, 'visualViewport', { value: viewport }); });
  await login(page); await page.getByRole('navigation', { name: '手机导航' }).getByRole('link', { name: '家庭' }).click(); await page.getByRole('button', { name: '安装应用', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '安装 MollyTime' }); await expect(dialog).toBeVisible();
  await page.evaluate(() => { Object.assign(visualViewport!, { height: 330, offsetTop: 60 }); visualViewport!.dispatchEvent(new Event('resize')); });
  await expect.poll(async () => { const box = (await dialog.boundingBox())!; return box.y >= 60 && box.y + box.height <= 390; }).toBe(true);
});
