import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
}

test('real upload, parent preview, publish and homepage draft publication', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  const folder = mkdtempSync(join(tmpdir(), 'molly-upload-'));
  const file = join(folder, '自然小故事.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xc8a464:s=320x180:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
  try {
    await login(page);
    await page.getByRole('button', { name: '＋ 上传资源', exact: true }).click();
    await page.getByLabel('新系列名称').fill('自然与发现');
    await page.getByLabel('选择上传文件').setInputFiles(file);
    await page.getByRole('button', { name: '开始上传 1 个文件' }).click();
    await expect(page.locator('dialog')).not.toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: '上传任务' }).click();
    await expect(page.getByText('文件就绪', { exact: true })).toBeVisible({ timeout: 20000 });
    await page.getByRole('navigation').getByRole('button', { name: '资源库' }).click();
    await page.getByRole('button', { name: '自然与发现', exact: true }).click();
    await page.getByRole('button', { name: '第 1 季', exact: true }).click();
    await page.getByRole('button', { name: '自然小故事', exact: true }).click();
    await expect(page.getByText('预览不计入儿童观看时长，也不修改儿童续播位置。')).toBeVisible();
    await expect(page.locator('video')).toHaveAttribute('src', /mediaId=/);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '发布', exact: true }).click();
    await expect(page.locator('.badge.published')).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: '首页编排' }).click();
    await page.getByLabel('栏目标题').fill('今晚一起看');
    await page.getByRole('button', { name: '保存草稿' }).click();
    await expect(page.getByText('草稿已保存，电视首页尚未改变。')).toBeVisible();
    await page.getByRole('button', { name: '发布首页', exact: true }).click();
    await expect(page.getByText('首页已发布。电视进入或返回首页时更新。')).toBeVisible();
    await expect(page.locator('.tv-shelf').getByText('今晚一起看')).toBeVisible();
    await page.screenshot({ path: '../../artifacts/parent-home-editor.png', fullPage: true });
    await page.getByRole('navigation').getByRole('button', { name: '资源库' }).click();
    await page.screenshot({ path: '../../artifacts/parent-resources.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { rmSync(folder, { recursive: true }); }
});

test('real device telemetry, reports, child management and mobile layout', async ({ page }) => {
  await login(page);
  const auth = await (await page.request.post('/api/auth/login', { headers: { 'X-Molly-Client': 'tv-shell/2' }, data: { username: 'parent', password: 'parent-e2e' } })).json();
  const headers = { Authorization: `Bearer ${auth.accessToken}` };
  const session = await (await page.request.post('/api/playback/sessions', { headers, data: { episodeId: 'episode', childId: 'child' } })).json();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const data = { seq: 0, startMs: 0, endMs: 1000, playedMs: 1000, positionMs: 1000 };
  expect((await page.request.post(`/api/playback/sessions/${session.sessionId}/events`, { headers, data })).ok()).toBe(true);
  expect((await page.request.post(`/api/playback/sessions/${session.sessionId}/events`, { headers, data })).ok()).toBe(true);
  await page.getByRole('navigation').getByRole('button', { name: '观看记录' }).click();
  await expect(page.locator('.watch-summary').getByText('1 秒', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Hello', exact: true })).toBeVisible();
  await page.screenshot({ path: '../../artifacts/parent-watch-report.png', fullPage: true });
  await page.getByRole('navigation').getByRole('button', { name: '家庭设置' }).click();
  await page.getByLabel('儿童名称').fill('小豆');
  await page.getByRole('button', { name: '添加儿童' }).click();
  await expect(page.getByText('小豆', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '../../artifacts/parent-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByText('已撤销', { exact: true })).toBeVisible();
  expect((await page.request.get('/api/home', { headers })).status()).toBe(401);
});
