import { test, expect } from '@playwright/test';

function wav() {
  const pcm = Buffer.alloc(3200);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
test('operator uploads, previews, persists and removes the launch sound', async ({ page }) => {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('operator@example.test');
  await page.getByLabel('密码', { exact: true }).fill('operator-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: '运营设置' }).click();
  await page.getByRole('tab', { name: '启动音效', exact: true }).click();
  await expect(page.getByRole('heading', { name: '启动音效' })).toBeVisible();
  await page.getByLabel('选择音频').setInputFiles({ name: 'welcome.wav', mimeType: 'audio/wav', buffer: wav() });
  await expect(page.locator('audio')).toHaveAttribute('src', /^blob:/);
  await page.getByRole('button', { name: '保存启动音效' }).click();
  await expect(page.getByText('当前音效：welcome.wav · 0.2 秒')).toBeVisible();
  await expect(page.locator('audio')).toHaveAttribute('src', /^\/api\/startup\/audio\/[a-f0-9]{64}$/);
  await page.reload();
  await expect(page.getByText('当前音效：welcome.wav · 0.2 秒')).toBeVisible();
  await page.screenshot({ path: '/tmp/mollytime-startup-sound-operations.png', fullPage: true });
  await page.getByRole('button', { name: '移除音效' }).click();
  await expect(page.getByText('当前未配置启动音效')).toBeVisible();
  await expect(page.locator('audio')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
