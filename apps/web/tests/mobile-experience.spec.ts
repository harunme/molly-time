import { test, expect, type Page } from '@playwright/test';
async function login(page: Page) {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: (page.viewportSize()?.width ?? 1440) < 1024 ? '今天' : '概览', exact: true })).toBeVisible();
}
test('desktop and mobile mount independent shells while preserving the same session and route', async ({ page }) => {
  await login(page);
  await expect(page.locator('.workspace')).toBeVisible();
  await page.goto('/manage/#/library/season');
  await expect(page.getByRole('dialog', { name: '第 1 季', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.workspace')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '第 1 季', exact: true })).toBeVisible();
  await expect(page.locator('.library-folder-panel')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('.m-app')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '第 1 季', exact: true })).toBeVisible();
});
test('native empty television state explains the next action without mounting desktop settings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  await page.getByRole('navigation', { name: '手机导航' }).getByRole('link', { name: '电视', exact: true }).click();
  await expect(page.getByRole('heading', { name: '让故事在大屏幕上发生' })).toBeVisible();
  await expect(page.locator('.watch-controls')).toHaveCount(0);
  await page.locator('.m-empty').getByRole('button', { name: '连接电视', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
test('mobile recently deleted records support restore without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  const session = await (await page.request.get('/api/manage/auth/session')).json(), headers = { 'X-CSRF-Token': session.csrfToken };
  const folder = await (await page.request.post('/api/manage/resources', { headers, data: { type: 'Series', name: `手机恢复检查 ${Date.now()}` } })).json();
  try {
    expect((await page.request.post(`/api/manage/resources/${folder.id}/archive`, { headers })).ok()).toBe(true);
    await page.goto('/manage/#/trash');
    await expect(page.getByRole('heading', { name: '最近删除', exact: true })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: folder.name });
    await expect(row).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await row.getByRole('button', { name: '恢复', exact: true }).click();
    await expect(row).toHaveCount(0);
  } finally { await page.request.post(`/api/manage/resources/${folder.id}/archive`, { headers }); await page.request.delete(`/api/manage/trash/${folder.id}`, { headers }); }
});
