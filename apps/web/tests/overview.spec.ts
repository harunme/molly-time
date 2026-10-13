import { test, expect } from '@playwright/test';

test('overview is the default home, uses aggregates and paged widgets, and links to management pages', async ({ page }) => {
  const errors: string[] = [];
  const requests: URL[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes('/api/manage/')) requests.push(new URL(request.url()));
  });
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  const response = page.waitForResponse((result) => new URL(result.url()).pathname === '/api/manage/overview' && result.ok());
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const data = await (await response).json();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: '管理导航', exact: true });
  await expect(navigation.getByRole('button', { name: '概览', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(navigation.getByRole('button', { name: '首页编排', exact: true })).toHaveCount(0);
  const metric = page.locator('.overview-metric').filter({ hasText: '视频资源' });
  await expect(metric.locator('.overview-metric-value')).toHaveText(data.media.videos.toLocaleString('zh-CN'));
  await expect(page.getByRole('navigation', { name: '概览上传分页', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '概览设备分页', exact: true })).toBeVisible();
  expect(requests.filter((url) => ['/api/manage/uploads', '/api/manage/devices'].includes(url.pathname)).every((url) => url.searchParams.get('pageSize') === '5' && url.searchParams.has('page'))).toBeTruthy();
  expect(requests.some((url) => url.pathname.includes('home-config') || url.pathname === '/api/manage/resources')).toBeFalsy();
  await page.screenshot({ path: '../../artifacts/manage-overview-desktop.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '管理资源', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: '概览', exact: true }).click();
  await page.getByRole('button', { name: '查看近 7 天观看次数', exact: true }).click();
  await expect(page.getByRole('heading', { name: '观看记录', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '管理资源', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: '../../artifacts/manage-overview-mobile.png', fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});
