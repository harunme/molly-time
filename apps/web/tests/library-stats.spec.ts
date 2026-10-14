import { expect, test } from '@playwright/test';

test('library statistics switch between all resources and the current folder', async ({ page }) => {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  const folderResponse = await page.request.post('/api/manage/resources', {
    headers, data: { type: 'Series', name: '文件夹统计检查' },
  });
  expect(folderResponse.ok()).toBeTruthy();
  const folder = await folderResponse.json();
  try {
    await page.goto(`/manage/#/library/${folder.id}`);
    const summary = page.locator('.library-summary');
    await expect(summary).toContainText('当前文件夹内容');
    await expect(summary).toContainText('0 个视频');
    const videoResponse = await page.request.post('/api/manage/resources', {
      headers, data: { type: 'Episode', name: '统计视频', parentId: folder.id },
    });
    expect(videoResponse.ok()).toBeTruthy();
    await page.reload();
    await expect(summary).toContainText('1 个视频');
    await expect(summary).toContainText('已发布 0%');
    await page.getByRole('button', { name: '全部文件夹', exact: true }).click();
    const all = await (await page.request.get('/api/manage/resources/stats')).json();
    expect(all.videoCount).toBeGreaterThan(1);
    await expect(summary).toContainText('资源库内容');
    await expect(summary).toContainText(`${all.videoCount} 个视频`);
  } finally {
    await page.request.post(`/api/manage/resources/${folder.id}/archive`, { headers });
  }
});
