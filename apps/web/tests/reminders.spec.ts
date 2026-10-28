import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const apiOrigin = process.env.MOLLYTIME_TEST_API_ORIGIN || 'http://127.0.0.1:8098';

test('parent uploads clips and actively ends the TV after its current episode', async ({ page }, testInfo) => {
  const folder = mkdtempSync(join(tmpdir(), 'mollytime-reminders-'));
  const file = join(folder, '家长提醒.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x456757:s=320x180:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('/manage/');
    await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
    await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '我的电视', exact: true }).click();
    await expect(page.getByRole('heading', { name: '家长视频提醒' })).toBeVisible();
    await expect(page.getByRole('button', { name: '这集看完休息', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '恢复播放', exact: true })).toHaveCount(0);
    await page.getByLabel('上传剩 1 集提醒视频').setInputFiles(file);
    await expect.poll(async () => (await (await page.request.get('/api/manage/reminders')).json()).warning.ready,
      { timeout: 20000 }).toBe(true);
    await page.getByLabel('上传休息提醒视频').setInputFiles(file);
    await expect.poll(async () => (await (await page.request.get('/api/manage/reminders')).json()).farewell.ready,
      { timeout: 20000 }).toBe(true);
    await expect(page.getByRole('button', { name: '预览休息提醒', exact: true })).toBeVisible({ timeout: 10000 });

    const auth = await (await page.request.post(`${apiOrigin}/api/auth/login`, {
      headers: { 'X-Molly-Client': 'tv-shell/2' }, data: { username: 'parent@example.test', password: 'parent-e2e' },
    })).json();
    const session = await (await page.request.get('/api/manage/auth/session')).json();
    const renamed = await page.request.patch(`/api/manage/devices/${auth.deviceId}`, {
      headers: { 'X-CSRF-Token': session.csrfToken }, data: { name: '提醒测试电视' },
    });
    expect(renamed.ok()).toBe(true);
    await page.request.put('/api/manage/watch-control/pin', {
      headers: { 'X-CSRF-Token': session.csrfToken }, data: { pin: '1234' },
    });
    const policy = await (await page.request.get('/api/manage/watch-control')).json();
    const devicePolicy = policy.devices.find((device: { deviceId: string }) => device.deviceId === auth.deviceId);
    const configured = await page.request.post(`/api/manage/watch-control/${auth.deviceId}/commands`, {
      headers: { 'X-CSRF-Token': session.csrfToken }, data: {
        requestId: crypto.randomUUID(), version: devicePolicy.version, action: 'settings', enabled: true, mode: 'minutes', amount: 30,
      },
    });
    expect(configured.ok()).toBe(true);
    const daily = await configured.json();
    const parentPage = await page.context().newPage();
    await parentPage.goto('/manage/');
    await parentPage.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '概览', exact: true }).click();
    await expect(parentPage.getByRole('group', { name: '播放控制', exact: true })).toBeVisible();
    await expect(parentPage.getByLabel('上传剩 1 集提醒视频')).toHaveCount(0);
    await expect(parentPage.getByLabel('提醒哪台电视')).toHaveCount(0);
    await expect(parentPage.getByRole('button', { name: '这集看完休息', exact: true })).toBeDisabled();
    await parentPage.screenshot({ path: testInfo.outputPath('parent-reminders.png'), fullPage: true });
    await page.addInitScript((binding) => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify(binding)), {
      accessToken: auth.accessToken, refreshToken: auth.refreshToken, deviceId: auth.deviceId, childId: 'autoplay-child',
    });
    // Keep real MP4 upload validation. Supply the same test video in WebM for
    // headless Chromium builds that lack H.264; all reminder APIs remain real.
    const webm = await (await page.request.get(`${apiOrigin}/api/episodes/browser-episode/play`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    })).body();
    await page.route('**/api/reminders/*/play?*', (route) => {
      const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), webm.length - 1) : webm.length - 1;
      return route.fulfill({ status: range ? 206 : 200, contentType: 'video/webm', body: webm.subarray(start, end + 1),
        headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${webm.length}` } : {}) } });
    });
    await page.goto(`${apiOrigin}/tv/`);
    await page.getByRole('button', { name: /英语启蒙/ }).click();
    await page.getByRole('button', { name: /第 1 季/ }).click();
    await page.locator('[data-focus="episode-browser-episode"]').click();
    const mainVideo = page.getByRole('dialog', { name: '视频播放', exact: true }).locator(':scope > video');
    await expect.poll(() => mainVideo.evaluate((video) => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await mainVideo.evaluate((video) => { (video as HTMLVideoElement).pause(); (video as HTMLVideoElement).currentTime = 1; });
    const onlineCount = (await (await parentPage.request.get('/api/manage/reminders/devices')).json()).filter((device: { online: boolean }) => device.online).length;
    await expect(parentPage.getByRole('button', { name: '这集看完休息', exact: true })).toBeEnabled({ timeout: 10000 });
    const issued = parentPage.waitForResponse((response) => response.url().endsWith('/api/manage/reminders/requests') && response.request().method() === 'POST');
    await parentPage.getByRole('button', { name: '这集看完休息', exact: true }).click();
    if (onlineCount > 1) await parentPage.getByRole('dialog', { name: '选择要提醒的电视' }).getByRole('button', { name: '提醒：提醒测试电视', exact: true }).click();
    const command = await issued;
    expect(command.ok()).toBe(true);
    const clip = page.getByRole('dialog', { name: '家长视频提醒', exact: true });
    await expect(clip).toHaveAttribute('data-parent-clip', '茉莉，还剩 1 集哦');
    await expect.poll(() => mainVideo.evaluate((video) => (video as HTMLVideoElement).paused)).toBe(true);
    await expect.poll(() => clip.locator('video').evaluate((video) => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await expect.poll(() => clip.locator('video').evaluate((video) => (video as HTMLVideoElement).paused)).toBe(false);
    await clip.locator('video').evaluate((video) => { (video as HTMLVideoElement).currentTime = (video as HTMLVideoElement).duration - 0.1; });
    await expect(clip).toHaveCount(0, { timeout: 10000 });
    await expect.poll(() => mainVideo.evaluate((video) => (video as HTMLVideoElement).paused)).toBe(false);
    expect(await mainVideo.evaluate((video) => (video as HTMLVideoElement).currentTime)).toBeLessThan(3);
    await mainVideo.evaluate((video) => { (video as HTMLVideoElement).currentTime = (video as HTMLVideoElement).duration - 0.1; });
    await expect(clip).toHaveAttribute('data-parent-clip', '休息提醒');
    await expect.poll(() => clip.locator('video').evaluate((video) => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await expect.poll(() => clip.locator('video').evaluate((video) => (video as HTMLVideoElement).paused)).toBe(false);
    await clip.locator('video').evaluate((video) => { (video as HTMLVideoElement).currentTime = (video as HTMLVideoElement).duration - 0.1; });
    await expect(page.getByRole('dialog', { name: '视频播放', exact: true })).toHaveCount(0);
    await expect.poll(async () => (await (await page.request.get(`${apiOrigin}/api/reminders/state`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    })).json()).phase).toBe('idle');
    const quota = await (await page.request.get(`${apiOrigin}/api/watch-control`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    })).json();
    expect(quota.status).toBe('allowed');
    expect(quota.round.id).toBe(daily.round.id);
    expect(quota.round.limitMs).toBe(30 * 60000);
    expect(quota.round.remainingMs).toBeGreaterThan(29 * 60000);
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const report = await (await page.request.get(`${apiOrigin}/api/manage/reports/watch-time?start=${date}&end=${date}`)).json();
    expect(report.sessions.filter((session: { deviceName: string }) => session.deviceName === 'MollyTime TV').every(
      (session: { name: string }) => session.name === 'Browser fixture')).toBe(true);
    await expect(parentPage.getByRole('button', { name: '恢复播放', exact: true })).toHaveCount(0);
    // Reopening the app and selecting again uses the same unspent daily quota.
    await page.reload();
    await page.getByRole('button', { name: /英语启蒙/ }).click();
    await page.getByRole('button', { name: /第 1 季/ }).click();
    await page.locator('[data-focus="episode-browser-episode"]').click();
    await expect(mainVideo).toBeVisible();
    await expect(page.getByRole('dialog', { name: '家长视频提醒', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '视频播放', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
