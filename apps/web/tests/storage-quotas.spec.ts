import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { formatStorageBytes } from '../src/storage-format';

test('storage sizes match the shared iOS and Android contract', () => {
  const fixture = readFileSync(new URL('../../../tools/fixtures/storage-byte-format.tsv', import.meta.url), 'utf8');
  for (const row of fixture.trim().split('\n').slice(1)) {
    const [value, expected] = row.split('\t');
    expect(formatStorageBytes(Number(value)), `${value} bytes`).toBe(expected);
  }
});

test('superadmin configures shared family storage, survives reload and recovers from save failure', async ({ page }) => {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('operator@example.test');
  await page.getByLabel('密码', { exact: true }).fill('operator-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: '运营设置' }).click();
  await page.getByRole('tab', { name: '用户管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '用户管理', exact: true })).toBeVisible();
  const parent = page.getByRole('row').filter({ has: page.getByText('parent@example.test', { exact: true }) });
  await expect(parent).toContainText('5.0 GiB');
  await parent.getByRole('button', { name: /配置/ }).click();
  const dialog = page.getByRole('dialog', { name: '配置家庭空间额度' });
  const limit = dialog.getByLabel('家庭空间额度（GiB）');
  await expect(dialog).toContainText('1 GiB = 1024 MiB = 1,073,741,824 字节');
  await limit.fill('-1');
  await expect(dialog.getByRole('button', { name: '保存额度' })).toBeDisabled();
  await limit.fill('100');
  const saving = page.waitForRequest(request => request.method() === 'PUT' && request.url().endsWith('/operations/users/parent/storage'));
  await dialog.getByRole('button', { name: '保存额度' }).click();
  expect((await saving).postDataJSON().limitBytes).toBe(107374182400);
  await expect(dialog).toHaveCount(0);
  await expect(parent).toContainText('100.0 GiB');
  const operator = page.getByRole('row').filter({ has: page.getByText('operator@example.test', { exact: true }) });
  await expect(operator).toContainText('100.0 GiB');
  const receiver = page.getByRole('row').filter({ has: page.getByText('receiver@example.test', { exact: true }) });
  await expect(receiver).toContainText('5.0 GiB');
  await page.reload();
  await expect(parent).toContainText('100.0 GiB');
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
