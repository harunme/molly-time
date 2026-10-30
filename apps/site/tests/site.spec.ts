import { test, expect, type Page } from '@playwright/test';

async function capture(page: Page, path: string) {
  await page.evaluate(async () => {
    document.querySelectorAll<HTMLImageElement>('img').forEach((image) => { image.loading = 'eager'; });
    await Promise.all(Array.from(document.images).map((image) => image.decode()));
    for (const image of document.images) {
      image.scrollIntoView();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    window.scrollTo(0, 0);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect.poll(() => page.evaluate(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
  await page.screenshot({ path, fullPage: true });
}

test('homepage has working navigation, metadata, FAQ and no browser errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('让孩子的每次观看，都有你的用心在里面。');
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', 'https://mollytime.app');
  await expect(page.getByRole('link', { name: '进入家长后台' }).first()).toHaveAttribute('href', '/manage/');
  await expect(page.getByRole('link', { name: '进入家长后台' }).first()).toHaveCSS('background-color', 'rgb(248, 222, 126)');
  await expect(page.getByRole('link', { name: '进入家长后台' }).first()).toHaveCSS('color', 'rgb(63, 58, 50)');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(250, 250, 244)');
  await page.getByRole('navigation', { name: '主要导航', exact: true }).getByRole('link', { name: '产品功能' }).click();
  await expect(page).toHaveURL(/#features$/);
  await expect(page.locator('#features > div').last()).toHaveCSS('opacity', '1');
  await page.locator('#faqs summary').filter({ hasText: '哪些电视可以使用？' }).click();
  await expect(page.locator('#faqs details').nth(1)).toHaveAttribute('open', '');
  await expect(page.locator('#faqs details').first()).not.toHaveAttribute('open', '');
  await page.getByRole('button', { name: '切换深浅色主题' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByRole('link', { name: '进入家长后台' }).first()).toHaveCSS('color', 'rgb(63, 58, 50)');
  await capture(page, 'test-results/dark.png');
  await page.getByRole('button', { name: '切换深浅色主题' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  expect(errors).toEqual([]);
  const share = await page.request.get('/site/share.png');
  expect(share.status()).toBe(200);
  expect(share.headers()['content-type']).toContain('image/png');
  await page.goto('/');
  await capture(page, 'test-results/desktop.png');
});

test('mobile menu, anchors and layout at narrow phone widths', async ({ page }) => {
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '打开导航菜单' }).click();
  await page.getByRole('navigation', { name: '主要导航' }).getByRole('link', { name: '如何开始' }).click();
  await expect(page).toHaveURL(/#how-it-works$/);
  await expect(page.locator('#header')).not.toHaveClass(/expanded/);
  await page.getByRole('button', { name: '打开导航菜单' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#header')).not.toHaveClass(/expanded/);
  await page.goto('/');
  await capture(page, 'test-results/mobile.png');
});

test('download absence and server failure permit retry', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/client/releases/latest', (route) => {
    attempts++;
    return route.fulfill(attempts === 1 ? { json: { release: null } } : { status: 503, body: 'unavailable' });
  });
  await page.goto('/#download');
  const button = page.getByRole('button', { name: '下载电视端' });
  await button.click();
  await expect(page.locator('#download-status')).toContainText('尚未发布');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator('#download-status')).toContainText('请稍后重试');
  await expect(button).toBeEnabled();
});

test('formal channel APK downloads and untrusted destinations are rejected', async ({ page }) => {
  const path = `/api/client/releases/com.molly.tv/7/${'a'.repeat(64)}.apk`;
  let destination = path;
  await page.route('**/api/client/releases/latest', (route) => route.fulfill({ json: {
    release: { packageName: 'com.molly.tv', url: destination, versionName: '1.0.0', size: 1048576 },
  } }));
  await page.route(`**${path}`, (route) => route.fulfill({ body: 'apk-fixture', contentType: 'application/vnd.android.package-archive', headers: { 'Content-Disposition': 'attachment; filename="mollytime-tv.apk"' } }));
  await page.goto('/#download');
  const button = page.getByRole('button', { name: '下载电视端' });
  const pending = page.waitForEvent('download');
  await button.click();
  expect((await pending).suggestedFilename()).toBe('mollytime-tv.apk');
  await expect(page.locator('#download-status')).toContainText('v1.0.0 · 1.0 MB');
  destination = `https://untrusted.example${path}`;
  await button.click();
  await expect(page.locator('#download-status')).toContainText('地址无效');
  await expect(button).toBeEnabled();
});
