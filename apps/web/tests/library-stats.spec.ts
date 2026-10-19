import { expect, test } from '@playwright/test';

test('library keeps navigation and actions without overview statistics or filters', async ({ page }) => {
  const statsRequests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/manage/resources/stats') statsRequests.push(request.url());
  });
  await page.goto('/manage/#/library');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  await expect(page.locator('.resource-desktop')).toBeVisible();
  await expect(page.getByRole('button', { name: '领取分享', exact: true })).toHaveCount(0);
  await expect(page.locator('.library-summary')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '搜索资源', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.locator('.desktop-instructions')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加内容', exact: true })).toBeVisible();
  await page.screenshot({ path: '../../artifacts/library-simple.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '英语启蒙', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '英语启蒙', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '领取分享', exact: true })).toHaveCount(0);
  await expect(page.locator('.library-summary')).toHaveCount(0);
  expect(statsRequests).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../../artifacts/library-simple-mobile.png', fullPage: true, animations: 'disabled' });
});
