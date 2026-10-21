import { chooseSelect } from "./select";
import { test, expect } from '@playwright/test';

test('admin and TV share defaults while remote playback choices stay local to the video', async ({ page, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^(概览|资源库)$/ })).toBeVisible();
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '家庭设置', exact: true }).click();
  await page.getByRole('tab', { name: '观看管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '家庭设置', exact: true })).toBeVisible();
  await chooseSelect(page.getByLabel('默认字幕', { exact: true }), 'en');
  await page.getByRole('button', { name: '保存默认字幕' }).click();
  await expect.poll(async () => (await (await page.request.get('/api/manage/settings')).json()).defaultSubtitle).toBe('en');
  await page.screenshot({ path: 'test-results/subtitle-admin-settings.png', fullPage: true });

  const auth = await (await page.request.post('/api/auth/login', {
    headers: { 'X-Molly-Client': 'tv-shell/2' }, data: { username: 'parent@example.test', password: 'parent-e2e' },
  })).json();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = await context.newPage();
  tv.on('pageerror', (error) => errors.push(error.message));
  try {
    await tv.addInitScript((binding) => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify(binding)), {
      accessToken: auth.accessToken, refreshToken: auth.refreshToken, deviceId: auth.deviceId, childId: 'child',
    });
    await tv.goto(`http://127.0.0.1:${process.env.MOLLYTIME_E2E_PORT || '8098'}/tv/`);
    await tv.getByRole('button', { name: '设置', exact: true }).click();
    const preference = tv.getByRole('region', { name: '默认字幕' });
    const subtitleSelect = preference.getByRole('combobox', { name: '默认字幕' });
    await expect(subtitleSelect).toHaveText('英文⌄');
    await expect(tv.getByRole('button', { name: '重新配对', exact: true })).toBeFocused();
    await subtitleSelect.focus();
    await tv.keyboard.press('Enter');
    await expect(preference.getByRole('option', { name: '英文', exact: true })).toBeFocused();
    await tv.keyboard.press('ArrowDown');
    await tv.keyboard.press('Enter');
    await expect(subtitleSelect).toHaveText('中英文⌄');
    await expect(subtitleSelect).toBeFocused();
    await expect.poll(async () => (await (await page.request.get('/api/manage/settings')).json()).defaultSubtitle).toBe('zh-en');
    await tv.screenshot({ path: 'test-results/subtitle-tv-settings.png' });
    await tv.getByRole('button', { name: '返回媒体库' }).click();

    const openVideo = async () => {
      await tv.evaluate(() => window.dispatchEvent(new CustomEvent('molly:browserPlay', { detail: { episodeId: 'browser-episode', fromStart: true } })));
      await expect(tv.locator('video')).toBeVisible();
      await expect.poll(() => tv.locator('video').evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
      await tv.locator('video').evaluate((node) => (node as HTMLVideoElement).pause());
    };
    const modes = () => tv.locator('video').evaluate((node) => Array.from((node as HTMLVideoElement).textTracks).map((track) => track.mode));
    await openVideo();
    await expect.poll(modes).toEqual(['disabled', 'disabled', 'showing']);
    await tv.keyboard.press('ContextMenu');
    const menu = tv.getByRole('dialog', { name: '播放设置', exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: '中英文 · browser-zh-en.srt' })).toBeFocused();
    await tv.keyboard.press('ArrowUp');
    await expect(menu.getByRole('button', { name: '英文 · browser-en.srt' })).toBeFocused();
    await tv.keyboard.press('Enter');
    await expect.poll(modes).toEqual(['disabled', 'showing', 'disabled']);
    await menu.getByRole('button', { name: '1.5×', exact: true }).focus();
    await tv.keyboard.press('Enter');
    await expect.poll(() => tv.locator('video').evaluate((node) => (node as HTMLVideoElement).playbackRate)).toBe(1.5);
    const refreshed = tv.waitForResponse((response) => response.url().includes('/api/episodes/browser-episode/playback?') && response.status() === 200);
    await tv.locator('video').evaluate((node) => node.dispatchEvent(new Event('error')));
    await refreshed;
    await expect.poll(() => tv.locator('video').evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
    await tv.locator('video').evaluate((node) => (node as HTMLVideoElement).pause());
    await expect.poll(modes).toEqual(['disabled', 'showing', 'disabled']);
    await expect.poll(() => tv.locator('video').evaluate((node) => (node as HTMLVideoElement).playbackRate)).toBe(1.5);
    await tv.screenshot({ path: 'test-results/subtitle-playback-menu.png' });
    await menu.getByRole('button', { name: '关闭字幕', exact: true }).click();
    await expect.poll(modes).toEqual(['disabled', 'disabled', 'disabled']);
    await tv.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
    await expect(tv.locator('video')).toBeVisible();
    await expect(tv.locator('video')).toBeFocused();
    await tv.keyboard.press('Escape');
    await expect(tv.locator('video')).toHaveCount(0);
    expect((await (await page.request.get('/api/manage/settings')).json()).defaultSubtitle).toBe('zh-en');
    await openVideo();
    await expect.poll(modes).toEqual(['disabled', 'disabled', 'showing']);
    await expect.poll(() => tv.locator('video').evaluate((node) => (node as HTMLVideoElement).playbackRate)).toBe(1);
    await tv.keyboard.press('Escape');

    await page.reload();
    await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '家庭设置', exact: true }).click();
    await page.getByRole('tab', { name: '观看管理', exact: true }).click();
    await expect(page.getByLabel('默认字幕', { exact: true })).toHaveAttribute('data-value', 'zh-en');
    await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '资源库', exact: true }).click();
    await page.getByRole('button', { name: '英语启蒙', exact: true }).click();
    await page.getByRole('button', { name: '第 1 季', exact: true }).click();
    await page.getByRole('button', { name: '更多操作 Browser fixture', exact: true }).click();
    await page.getByRole('menuitem', { name: '字幕设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '字幕资源' })).toBeVisible();
    await expect(page.getByText('默认字幕', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('字幕类型').nth(2)).toHaveAttribute('data-value', 'zh-en');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
