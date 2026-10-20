import { test, expect } from '@playwright/test';

test('operator imports a playlist, persists it, and turns off TV viewing', async ({ page }) => {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('operator@example.test');
  await page.getByLabel('密码', { exact: true }).fill('operator-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: '运营设置' }).click();
  await page.getByRole('tab', { name: '电视直播', exact: true }).click();
  await expect(page.getByRole('heading', { name: '电视直播（实验）' })).toBeVisible();
  await page.getByLabel('或上传 M3U / TXT 列表（最大 2 MB）').setInputFiles({ name: 'test.m3u', mimeType: 'text/plain', buffer: Buffer.from('#EXTM3U\n#EXTINF:-1 group-title="央视",CCTV 1\nhttps://example.com/live.m3u8\n') });
  await expect(page.getByText(/已开启 · 1 个频道/)).toBeVisible();
  await page.getByText('查看频道列表（1）').click();
  await expect(page.getByRole('cell', { name: 'CCTV 1', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/molly-live-tv-operations.png', fullPage: true });
  await page.reload();
  await expect(page.getByText(/已开启 · 1 个频道/)).toBeVisible();
  await page.getByRole('button', { name: '关闭电视直播', exact: true }).click();
  await expect(page.getByText(/未开启 · 1 个频道/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
