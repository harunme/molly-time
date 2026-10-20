import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { chooseSelect } from './select';

test('recycle bin supports archive, storage totals, restore, retention and permanent deletion', async ({ page }) => {
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  const container = await (await page.request.post('/api/manage/resources', {
    headers, data: { type: 'Series', name: '回收站检查容器' },
  })).json();
  const folders: string[] = [];
  try {
    for (let index = 0; index < 21; index++) {
      const response = await page.request.post('/api/manage/resources', {
        headers, data: { type: 'Series', name: `回收站检查${String(index).padStart(2, '0')}`, indexNumber: index + 1 },
      });
      expect(response.ok()).toBeTruthy();
      const folder = await response.json();
      folders.push(folder.id);
      expect((await page.request.post(`/api/manage/resources/${folder.id}/move`, {
        headers, data: { folderId: container.id },
      })).ok()).toBeTruthy();
    }
    const episode = await (await page.request.post('/api/manage/resources', {
      headers, data: { type: 'Episode', name: '回收站字幕样本', parentId: folders[20] },
    })).json();
    const subtitle = Buffer.from('1\n00:00:00,000 --> 00:00:02,000\nRecycle bin fixture\n');
    const upload = await (await page.request.post('/api/manage/uploads', {
      headers, data: { itemId: episode.id, filename: 'recycle.srt', size: subtitle.length, kind: 'subtitle', fingerprint: 'recycle-fixture' },
    })).json();
    expect((await page.request.put(`/api/manage/uploads/${upload.id}/chunks?offset=0`, {
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Chunk-SHA256': createHash('sha256').update(subtitle).digest('hex') }, data: subtitle,
    })).ok()).toBeTruthy();
    expect((await page.request.post(`/api/manage/uploads/${upload.id}/complete`, { headers })).ok()).toBeTruthy();
    await expect.poll(async () => (await (await page.request.get(`/api/manage/uploads/${upload.id}`)).json()).status).toBe('ready');

    const navigation = page.getByRole('navigation', { name: '管理导航' });
    await navigation.getByRole('link', { name: '资源库', exact: true }).click();
    await page.getByRole('button', { name: '回收站检查容器', exact: true }).click();
    const rows = page.locator('.resource-tile');
    const pagination = page.getByRole('navigation', { name: '资源库分页', exact: true });
    await expect(pagination).toContainText('共 21 条');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await pagination.getByRole('button', { name: /下一页/ }).click();
    await expect(rows).toHaveCount(1);
    await rows.first().getByRole('button', { name: '更多操作 回收站检查20' }).click();
    await page.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(pagination).toContainText('共 20 条');
    await expect(pagination).toContainText('第 1 / 1 页');
    await expect(rows).toHaveCount(20);
    await expect(page.locator('.selection-bar')).toHaveCount(0);
    await page.getByRole('button', { name: '返回全部文件夹', exact: true }).click();

    await navigation.getByRole('link', { name: '回收站', exact: true }).click();
    await expect(page).toHaveURL(/#\/trash$/);
    await page.reload();
    await expect(page.getByRole('heading', { name: '回收站', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '搜索回收站' })).toHaveCount(0);
    const row = page.getByRole('row').filter({ hasText: '回收站检查20' });
    await expect(row).toContainText('1 个视频');
    await expect(page.getByTestId('trash-used')).toHaveText(`${subtitle.length} B`);
    await expect(page.getByTestId('trash-reclaimable')).toHaveText(`${subtitle.length} B`);
    await navigation.getByRole('link', { name: '家庭设置', exact: true }).click();
    const policy = page.getByRole('combobox', { name: '回收站保留时间' });
    await expect(policy).toContainText('7 天后自动删除');
    await chooseSelect(policy, '30');
    await page.getByRole('button', { name: '保存策略' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('30 天后自动删除');
    await page.reload();
    await expect(policy).toContainText('30 天后自动删除');
    await navigation.getByRole('link', { name: '回收站', exact: true }).click();
    await expect(page.getByRole('heading', { name: '回收站', exact: true })).toBeVisible();
    await page.screenshot({ path: '/private/tmp/molly-trash-desktop.png', fullPage: true });
    await page.locator('.trash-summary').screenshot({ path: '/private/tmp/molly-trash-summary-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/private/tmp/molly-trash-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigation.getByRole('link', { name: '家庭设置', exact: true }).click();
    await chooseSelect(policy, '0');
    await page.getByRole('button', { name: '保存策略' }).click();
    await expect(page.getByRole('status')).toContainText('关闭自动删除');
    await navigation.getByRole('link', { name: '回收站', exact: true }).click();

    await row.getByRole('button', { name: '恢复', exact: true }).click();
    await expect(row).toHaveCount(0);
    await navigation.getByRole('link', { name: '资源库', exact: true }).click();
    await page.getByRole('button', { name: '回收站检查容器', exact: true }).click();
    await pagination.getByRole('button', { name: /下一页/ }).click();
    await page.getByRole('button', { name: '更多操作 回收站检查20', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '下架目录', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    expect((await page.request.post(`/api/manage/resources/${folders[20]}/archive`, { headers })).ok()).toBeTruthy();
    await page.getByRole('button', { name: '返回全部文件夹', exact: true }).click();
    await navigation.getByRole('link', { name: '回收站', exact: true }).click();
    await row.getByRole('button', { name: '立即删除', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: '彻底删除内容' });
    await expect(dialog).toContainText('无法恢复');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '立即删除', exact: true }).click();
    await dialog.getByRole('button', { name: '彻底删除', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId('trash-used')).toHaveText('0 B');
    expect((await page.request.get(`/api/manage/resources/${episode.id}`)).status()).toBe(404);
    expect(errors).toEqual([]);
  } finally {
    await page.request.put('/api/manage/trash/settings', { headers, data: { retentionDays: 7 } });
    for (const id of [...folders, container.id]) {
      await page.request.post(`/api/manage/resources/${id}/archive`, { headers });
      await page.request.delete(`/api/manage/trash/${id}`, { headers });
    }
  }
});
