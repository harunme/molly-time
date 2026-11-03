import { test, expect } from '@playwright/test';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('operator@example.test');
  await page.getByLabel('密码', { exact: true }).fill('operator-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: '运营设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '使用概览', exact: true })).toBeVisible();
}

test('overview is the default, supports ranges, family devices and mobile', async ({ page }) => {
  await login(page);
  await expect(page.locator('.analytics-stat')).toHaveCount(6);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.analytics-chart .analytics-bar-slot')).toHaveCount(30);
  await page.getByRole('button', { name: '近 7 天', exact: true }).click();
  await expect(page.locator('.analytics-chart .analytics-bar-slot')).toHaveCount(7);
  await page.getByRole('button', { name: '近 90 天', exact: true }).click();
  await expect(page.locator('.analytics-chart .analytics-bar-slot')).toHaveCount(90);
  await page.getByRole('button', { name: '新增激活', exact: true }).click();
  await expect(page.locator('.analytics-bar.uncollected').first()).toBeVisible();
  await page.getByLabel('搜索家庭').fill('我们的家庭');
  await expect(page.locator('.analytics-family-table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: '我们的家庭', exact: true }).click();
  await expect(page.locator('.analytics-devices')).toBeVisible();
  await page.getByLabel('搜索家庭').fill('无此家庭xyz');
  await expect(page.getByText('没有匹配的家庭。')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.analytics-stat')).toHaveCount(6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.analytics-chart .analytics-bar-slot')).toHaveCount(30);
  await page.screenshot({ path: '/tmp/molly-analytics-mobile.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/molly-analytics-desktop.png', fullPage: true, animations: 'disabled' });
});

test('failed statistics are not shown as zero and can recover', async ({ page }) => {
  await page.route('**/api/manage/operations/analytics/overview', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"temporarily unavailable"}' }));
  await login(page);
  await expect(page.getByRole('alert')).toContainText('统计加载失败');
  await expect(page.locator('.analytics-stat')).toHaveCount(0);
  await page.unroute('**/api/manage/operations/analytics/overview');
  await page.getByRole('button', { name: '重试加载' }).click();
  await expect(page.locator('.analytics-stat')).toHaveCount(6);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
