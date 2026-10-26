import { expect, test, type Page } from '@playwright/test';
import { mp4Fixture } from './mp4-fixture';

async function login(page: Page) {
  await page.request.post('/api/manage/auth/login', { data: { username: 'parent@example.test', password: 'parent' + '-e2e' } });
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  return { 'X-CSRF-Token': session.csrfToken };
}
const video = (name: string) => ({ name, mimeType: 'video/mp4', buffer: mp4Fixture() });

test('a file owns its progress and retry without opening the global task window', async ({ page }, testInfo) => {
  const headers = await login(page);
  const folder = await (await page.request.post('/api/manage/resources', { headers, data: { type: 'Series', name: '文件进度检查' } })).json();
  let fail = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/manage/uploads/*/chunks?*', async route => {
    if (fail) return route.fulfill({ status: 503, json: { detail: '测试网络中断，请重试' } });
    await gate; await route.continue();
  });
  try {
    await page.goto(`/manage/#/library/${folder.id}`);
    await page.getByLabel('选择上传视频', { exact: true }).setInputFiles(video('新的故事.mp4'));
    const tile = page.locator('.resource-tile').filter({ has: page.getByRole('button', { name: '新的故事', exact: true }) });
    const status = tile.getByRole('region', { name: '新的故事.mp4 上传状态', exact: true });
    await expect(status).toBeVisible();
    await expect(status.getByRole('alert')).toContainText('测试网络中断');
    await expect(page.getByRole('dialog', { name: '上传任务', exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/library/${folder.id}$`));
    fail = false;
    await status.getByRole('button', { name: '重试', exact: true }).click();
    await expect(status.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    await expect(status.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('library-file-upload.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('library-file-upload-mobile.png'), fullPage: true });
    expect(await status.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await status.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(status.getByRole('status')).toHaveText('已暂停');
    release();
    // Wait until the paused in-flight chunk settles before resuming the file.
    await expect.poll(async () => (await (await page.request.get(`/api/manage/uploads?itemIds=${(await (await page.request.get(`/api/manage/resources?parentId=${folder.id}`)).json())[0].id}`)).json())[0].offset).toBeGreaterThan(0);
    await status.getByRole('button', { name: '继续', exact: true }).click();
    await expect(status).toHaveCount(0, { timeout: 15000 });
    await expect(tile.locator('.library-item-status')).toBeVisible();
  } finally {
    release();
    await page.request.post(`/api/manage/resources/${folder.id}/archive`, { headers, timeout: 5000 });
    await page.request.delete(`/api/manage/trash/${folder.id}`, { headers, timeout: 5000 });
  }
});

test('reminder progress and errors stay under the matching file and recover after reload', async ({ page }, testInfo) => {
  const headers = await login(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let hold = true;
  await page.route('**/api/manage/uploads/*/chunks?*', async route => {
    if (hold) await gate;
    await route.continue().catch(() => {});
  });
  await page.goto('/manage/#/family/watching');
  const warning = page.locator('.reminder-clip').filter({ has: page.getByLabel('上传剩 1 集提醒视频', { exact: true }) });
  const farewell = page.locator('.reminder-clip').filter({ has: page.getByLabel('上传休息提醒视频', { exact: true }) });
  try {
    await warning.getByLabel('上传剩 1 集提醒视频', { exact: true }).setInputFiles(video('最后一集提醒.mp4'));
    const status = warning.getByRole('region', { name: '最后一集提醒.mp4 上传状态', exact: true });
    await expect(status.getByRole('progressbar')).toBeVisible();
    await expect(farewell.getByRole('progressbar')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '上传任务', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('reminder-file-upload.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath('reminder-file-upload-mobile.png'), fullPage: true });
    await page.reload();
    await expect(status.getByLabel('继续上传 最后一集提醒.mp4', { exact: true })).toBeAttached();
    hold = false; release();
    await status.getByLabel('继续上传 最后一集提醒.mp4', { exact: true }).setInputFiles(video('最后一集提醒.mp4'));
    await expect(warning.getByRole('button', { name: '预览提醒', exact: true })).toBeVisible({ timeout: 15000 });
    await expect(status).toHaveCount(0);
    await page.route('**/api/manage/reminders/farewell/upload-target', route => route.fulfill({ status: 503, json: { detail: '无法创建休息提醒，请重试' } }));
    await farewell.getByLabel('上传休息提醒视频', { exact: true }).setInputFiles(video('休息提醒.mp4'));
    await expect(farewell.getByRole('alert')).toHaveText('无法创建休息提醒，请重试');
    await expect(warning.getByRole('alert')).toHaveCount(0);
    await expect(page).toHaveURL(/family\/devices$/);
  } finally {
    release();
    const settings = await (await page.request.get('/api/manage/reminders')).json();
    if (settings.warning.itemId) {
      const uploads = await (await page.request.get(`/api/manage/uploads?pending=true&itemIds=${settings.warning.itemId}`)).json();
      for (const row of uploads) await page.request.post(`/api/manage/uploads/${row.id}/cancel`, { headers });
    }
  }
});
