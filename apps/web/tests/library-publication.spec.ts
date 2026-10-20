import { expect, test } from '@playwright/test';

test('publication separates folder visibility, supports selection and explains skipped videos', async ({ page }) => {
  await page.goto('/manage/#/library');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  const pending = await (await page.request.post('/api/manage/resources', { headers, data: { type: 'Episode', name: '等待文件检查', parentId: 'season' } })).json();
  try {
    await page.getByRole('button', { name: '英语启蒙', exact: true }).click();
    await page.getByRole('button', { name: '第 1 季', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '第 1 季', exact: true });
    await expect(dialog.getByRole('switch', { name: '在电视上显示此目录' })).toBeChecked();
    await dialog.getByRole('button', { name: '选择视频', exact: true }).click();
    await dialog.getByRole('button', { name: '全选当前页', exact: true }).click();
    await expect(dialog.getByRole('checkbox')).toHaveCount(4);
    await expect(dialog.getByText('已选 4 个视频', { exact: true })).toBeVisible();
    await page.screenshot({ path: '../../artifacts/library-publication-selection.png', animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '../../artifacts/library-publication-selection-mobile.png', animations: 'disabled' });
    expect(await dialog.getByRole('group', { name: '视频批量操作' }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route('**/api/manage/resources/publication', route => route.fulfill({ status: 503, json: { detail: '服务暂时不可用，请重试' } }));
    await dialog.getByRole('button', { name: '下架', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('服务暂时不可用，请重试');
    await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(4);
    await page.unroute('**/api/manage/resources/publication');
    await dialog.getByRole('button', { name: '下架', exact: true }).click();
    await expect(dialog.getByRole('status').filter({ hasText: '已下架 3 个视频' })).toBeVisible();
    await dialog.getByRole('button', { name: '全选当前页', exact: true }).click();
    await dialog.getByRole('button', { name: '上架', exact: true }).click();
    await expect(dialog.getByRole('status').filter({ hasText: '1 个尚未就绪，已跳过' })).toBeVisible();
    await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '选择视频', exact: true })).toBeFocused();
    await dialog.getByRole('switch', { name: '在电视上显示此目录' }).click();
    await expect(dialog.getByRole('switch')).not.toBeChecked();
    await expect(dialog.getByText('此目录已从电视隐藏。视频上架后仍不会出现在电视。', { exact: true })).toBeVisible();
    await expect(dialog.locator('.library-item-status').filter({ hasText: '已上架' })).toHaveCount(3);
    await expect(dialog.locator('.library-item-blocked')).toHaveCount(4);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '../../artifacts/library-publication-mobile.png', animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const toolbar = dialog.getByRole('group', { name: '视频批量操作' });
    expect(await toolbar.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: '上架目录内全部视频', exact: true }).click();
    await page.getByRole('button', { name: '上架全部视频', exact: true }).click();
    await expect(dialog.getByRole('status').filter({ hasText: '3 个受上级目录隐藏影响' })).toBeVisible();
    await dialog.getByRole('switch').click();
    await expect(dialog.getByRole('switch')).toBeChecked();
    await expect(dialog.locator('.library-item-blocked')).toHaveCount(0);
  } finally {
    await page.request.post('/api/manage/resources/season/publish', { headers });
    await page.request.post('/api/manage/resources/publication', { headers, data: { action: 'publish', ids: ['episode', 'browser-episode', 'browser-next'] } });
    await page.request.post(`/api/manage/resources/${pending.id}/archive`, { headers });
  }
});

test('selection is limited to the current page and clears when paging', async ({ page }) => {
  await page.goto('/manage/#/library');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  const folder = await (await page.request.post('/api/manage/resources', { headers, data: { type: 'Series', name: '分页选择测试' } })).json();
  try {
    for (let index = 0; index < 21; index++) await page.request.post('/api/manage/resources', { headers, data: { type: 'Episode', name: `待上传 ${index}`, parentId: folder.id } });
    await page.goto(`/manage/#/library/${folder.id}`);
    const dialog = page.getByRole('dialog', { name: folder.name, exact: true });
    await dialog.getByRole('button', { name: '选择视频', exact: true }).click();
    await dialog.getByRole('button', { name: '全选当前页', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(20);
    await expect(dialog.getByRole('button', { name: '上架', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '资源库分页：下一页', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '选择视频', exact: true })).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await dialog.getByRole('button', { name: '上架目录内全部视频', exact: true }).click();
    await page.getByRole('button', { name: '上架全部视频', exact: true }).click();
    await expect(dialog.getByRole('status').filter({ hasText: '21 个尚未就绪，已跳过' })).toBeVisible();
  } finally {
    await page.request.post(`/api/manage/resources/${folder.id}/archive`, { headers });
  }
});
