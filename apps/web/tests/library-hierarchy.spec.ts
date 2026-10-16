import { expect, test } from '@playwright/test';
import { chooseSelect } from './select';
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
    await expect(page.locator('.resource-row').first()).toContainText('第 2 季');
    await expect(page.locator('.resource-row').last()).toContainText('未分季');
    await page.getByRole('checkbox', { name: '选择 待整理视频' }).check();
    await chooseSelect(page.getByLabel('移入季', { exact: true }), { label: '冒险第二季' });
    await expect(page.getByRole('button', { name: '待整理视频', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '冒险第二季', exact: true }).click();
    await expect(page.locator('.breadcrumbs')).toContainText('分季整理测试');
    await expect(page.locator('.resource-row .name-button')).toHaveText(['待整理视频', '第二集', '第十集']);
    await chooseSelect(page.getByLabel('资源排序'), 'index-desc');
    await expect(page.locator('.resource-row .name-button')).toHaveText(['第十集', '第二集', '待整理视频']);
    await page.locator('.resource-row').filter({ hasText: '第十集' }).getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('第几集', { exact: true }).fill('3');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.resource-row').first()).toContainText('第 3 集');
    await page.getByRole('button', { name: '＋ 上传资源', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '上传资源', exact: true })).toContainText('上传到 冒险第二季');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel('资源排序')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '../../artifacts/library-hierarchy-mobile.png', fullPage: true });
    await page.locator('.breadcrumbs').getByRole('button', { name: '分季整理测试', exact: true }).click();
    await page.getByRole('button', { name: '＋ 上传资源', exact: true }).click();
    await chooseSelect(page.getByLabel('所属季', { exact: true }), { label: '冒险第二季' });
    await page.getByLabel('选择上传文件').setInputFiles({ name: '季内新集.mp4', mimeType: 'video/mp4', buffer: mp4Fixture() });
    await page.getByLabel('第几集 1', { exact: true }).fill('4');
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/manage/resources' && response.request().method() === 'POST');
    await page.getByRole('button', { name: '开始上传 1 个文件', exact: true }).click();
    const episode = await (await created).json();
    expect(episode.parentId).toBe(season.id);
    expect(episode.indexNumber).toBe(4);
    await expect.poll(async () => (await (await page.request.get(`/api/manage/resources/${episode.id}`)).json()).ready).toBe(true);
  } finally {
    await page.request.post(`/api/manage/resources/${series.id}/archive`, { headers });
  }
});
