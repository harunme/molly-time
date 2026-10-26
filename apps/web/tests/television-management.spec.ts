import { expect, test } from '@playwright/test';

for (const width of [390, 1440]) {
  test(`one TV row owns device actions and watching status at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.request.post('/api/manage/auth/login', { data: { username: 'parent@example.test', password: 'parent' + '-e2e' } });
    let name = '客厅电视';
    let unavailable = false;
    const paired = () => [
      { id: 'living', name, lastSeen: '2026-10-26T10:00:00Z' },
      { id: 'bedroom', name: '卧室电视', lastSeen: '2026-10-25T10:00:00Z' },
      { id: 'older', name: '旧电视', lastSeen: '2026-10-20T10:00:00Z' },
    ];
    await page.route('**/api/manage/devices?**', route => route.fulfill({ json: { items: paired(), total: 3, page: 1, pageSize: 20 } }));
    await page.route('**/api/manage/devices/living', async route => {
      name = route.request().postDataJSON().name;
      await route.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/manage/watch-control', route => unavailable ? route.fulfill({ status: 503, json: { detail: '观看状态暂不可用' } }) : route.fulfill({ json: { pinSet: true, devices: paired().map((d, index) => ({
      deviceId: d.id, name: d.name, online: index === 0, supported: index !== 2, enabled: index !== 2,
      mode: index === 0 ? 'minutes' : 'episodes', amount: index === 0 ? 60 : 2, version: 1, acknowledged: 1,
      status: index === 0 ? 'allowed' : 'resting',
      round: index === 0 ? { mode: 'minutes', remainingMs: 22 * 60000, amount: 60, cursor: 0, episodeId: null } : null,
    })) } }));
    await page.goto('/manage/#/family/watching');
    await expect(page).toHaveURL(/family\/devices$/);
    await expect(page.locator('.watch-control-device')).toHaveCount(3);
    const living = page.getByRole('region', { name: '客厅电视观看安排', exact: true });
    await expect(living.getByText('今日还能看 22 分钟', { exact: true })).toBeVisible();
    await expect(living.getByText('每日 60 分钟', { exact: true })).toBeVisible();
    await expect(living.getByRole('button', { name: '观看设置', exact: true })).toHaveCount(1);
    await expect(page.getByText('未限制观看', { exact: true })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath(`television-management-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await living.getByRole('button', { name: '客厅电视的更多操作' }).click();
    await expect(page.getByRole('menuitem', { name: '结束今日观看', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设备名称', exact: true });
    await dialog.getByLabel('新名称').fill('客厅大电视');
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    const renamed = page.getByRole('region', { name: '客厅大电视观看安排', exact: true });
    await expect(renamed.getByText('今日还能看 22 分钟', { exact: true })).toBeVisible();
    await renamed.getByRole('button', { name: '观看设置', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '客厅大电视 · 观看设置', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    unavailable = true;
    await page.reload();
    await expect(page.getByRole('alert').filter({ hasText: '观看状态暂不可用' })).toBeVisible();
    await expect(renamed).toBeVisible();
    await expect(renamed.getByRole('button', { name: '观看设置', exact: true })).toBeDisabled();
    await renamed.getByRole('button', { name: '客厅大电视的更多操作' }).click();
    await expect(page.getByRole('menuitem', { name: '取消配对', exact: true })).toBeEnabled();
    unavailable = false;
    await page.route('**/api/manage/auth/session', async route => {
      const session = await (await route.fetch()).json();
      await route.fulfill({ json: { ...session, user: { ...session.user, role: 'member' } } });
    });
    await page.reload();
    await expect(renamed.getByText('今日还能看 22 分钟', { exact: true })).toBeVisible();
    await expect(page.locator('.watch-control-device').getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '绑定电视', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重设家长密码', exact: true })).toHaveCount(0);
  });
}
