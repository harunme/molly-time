import { expect, test } from '@playwright/test';
import { mp4Fixture } from './mp4-fixture';

test('organize a cartoon into seasons, sort episodes and move existing videos', async ({ page }) => {
  await page.goto('/manage/#/library');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  const response = await page.request.post('/api/manage/resources', { headers, data: { type: 'Series', name: '分季整理测试' } });
  expect(response.ok()).toBeTruthy();
  const series = await response.json();
  try {
    await page.goto(`/manage/#/library/${series.id}`);
    await page.getByRole('button', { name: '新建季', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('冒险第二季');
    await page.getByLabel('第几季', { exact: true }).fill('2');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const seasons = await (await page.request.get(`/api/manage/resources?parentId=${series.id}`)).json();
    const season = seasons[0];
    for (const [name, indexNumber, parentId] of [['第十集', 10, season.id], ['第二集', 2, season.id], ['待整理视频', 1, series.id]] as const) {
      expect((await page.request.post('/api/manage/resources', { headers, data: { type: 'Episode', name, indexNumber, parentId } })).ok()).toBeTruthy();
    }
    await page.reload();
    await expect(page.locator('.resource-tile').first()).toContainText('SEASON 02');
    const from = (await page.getByRole('button', { name: '打开 待整理视频', exact: true }).boundingBox())!;
    const to = (await page.getByRole('button', { name: '打开 冒险第二季', exact: true }).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await expect(page.locator('.is-drop-target')).toBeVisible();
    await page.mouse.up();
    await expect(page.getByRole('button', { name: '待整理视频', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '冒险第二季', exact: true }).click();
    await expect(page.getByRole('button', { name: '返回分季整理测试', exact: true })).toBeVisible();
    await expect(page.locator('.resource-tile .name-button')).toHaveText(['待整理视频', '第二集', '第十集']);
    await page.getByRole('button', { name: '更多操作 第十集', exact: true }).click();
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
    await page.getByLabel('第几集', { exact: true }).fill('3');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.resource-tile').filter({ hasText: '第十集' })).toContainText('EP 03');
    const picker = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '＋ 上传资源', exact: true }).click();
    await (await picker).setFiles([]);
    await expect(page.getByRole('dialog', { name: '上传资源', exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel('资源排序')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '../../artifacts/library-hierarchy-mobile.png', fullPage: true });
    const uploadPicker = page.waitForEvent('filechooser');
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/manage/resources' && response.request().method() === 'POST');
    await page.getByRole('button', { name: '＋ 上传资源', exact: true }).click();
    await (await uploadPicker).setFiles({ name: '季内新集.mp4', mimeType: 'video/mp4', buffer: mp4Fixture() });
    const episode = await (await created).json();
    expect(episode.parentId).toBe(season.id);
    expect(episode.indexNumber).toBeNull();
    expect(episode.name).toBe('季内新集');
    await expect.poll(async () => (await (await page.request.get(`/api/manage/resources/${episode.id}`)).json()).ready).toBe(true);
  } finally {
    await page.request.post(`/api/manage/resources/${series.id}/archive`, { headers });
    await page.request.delete(`/api/manage/trash/${series.id}`, { headers });
  }
});
