import { test, expect } from '@playwright/test';

test('superadmin configures shared family storage, survives reload and recovers from save failure', async ({ page }) => {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('operator@example.test');
  await page.getByLabel('密码', { exact: true }).fill('operator-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: '运营设置' }).click();
  await page.getByRole('tab', { name: '用户管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '用户管理', exact: true })).toBeVisible();
  const parent = page.getByRole('row').filter({ has: page.getByText('parent@example.test', { exact: true }) });
  await expect(parent).toContainText('5.0 GB');
  await parent.getByRole('button', { name: /配置/ }).click();
  const dialog = page.getByRole('dialog', { name: '配置家庭空间额度' });
  const limit = dialog.getByLabel('家庭空间额度（GB）');
  await limit.fill('-1');
  await expect(dialog.getByRole('button', { name: '保存额度' })).toBeDisabled();
  await limit.fill('10');
  await dialog.getByRole('button', { name: '保存额度' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(parent).toContainText('10.0 GB');
  const operator = page.getByRole('row').filter({ has: page.getByText('operator@example.test', { exact: true }) });
  await expect(operator).toContainText('10.0 GB');
  const receiver = page.getByRole('row').filter({ has: page.getByText('receiver@example.test', { exact: true }) });
  await expect(receiver).toContainText('5.0 GB');
  await page.reload();
  await expect(parent).toContainText('10.0 GB');
  await page.screenshot({ path: '../../artifacts/storage-quotas-desktop.png', fullPage: true });
  await page.getByLabel('搜索用户').fill('receiver@example.test');
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await receiver.getByRole('button', { name: /配置/ }).click();
  await limit.fill('0');
  await page.route('**/api/manage/operations/users/receiver/storage', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '暂时无法保存' }),
  }));
  await dialog.getByRole('button', { name: '保存额度' }).click();
  await expect(dialog.getByRole('alert')).toContainText('暂时无法保存');
  await expect(limit).toHaveValue('0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../../artifacts/storage-quotas-mobile.png', fullPage: true });
  await page.unroute('**/api/manage/operations/users/receiver/storage');
  await dialog.getByRole('button', { name: '保存额度' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(receiver).toContainText('不限额');
});
