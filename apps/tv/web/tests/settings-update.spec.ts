import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page, { settings = true, release = true, failDownload = false } = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(({ release, failDownload }) => {
    const w = window as any;
    w.updateCalls = [];
    w.MollyBridge = { postMessage(raw: string) {
      const { id, method, args } = JSON.parse(raw);
      let result: any = { ok: true }, error: any;
      if (['checkUpdate', 'downloadUpdate', 'installUpdate'].includes(method)) w.updateCalls.push(method);
      if (method === 'getCapabilities') result = { bridgeVersion: 1, serverUrl: 'https://media.test', authenticated: true, nativePlayback: true, clientUpdates: true, shellVersion: '0.1.8' };
      if (method === 'request') {
        if (args.path.startsWith('/api/home')) result = { rows: [{ id: 'library', title: '我的媒体库', items: [{ id: 'maisy', name: 'Maisy Mouse', type: 'episode' }] }] };
        if (args.path === '/api/settings/playback') result = { defaultSubtitle: 'en' };
        if (args.path === '/api/families/me/children') result = [];
      }
      if (method === 'checkUpdate') result = { release: release ? { versionName: '0.1.9', size: 9 * 1024 * 1024, notes: '未加载完的文件夹不再显示为空。\n修复有网络时未缓存视频无法播放的问题。' } : null };
      if (method === 'downloadUpdate' && failDownload && w.updateCalls.filter((call: string) => call === 'downloadUpdate').length === 1) error = { message: '下载失败，请重试' };
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify(error ? { id, error } : { id, result }) }), 5);
    } };
  }, { release, failDownload });
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-maisy"]')).toBeFocused();
  await expect.poll(() => calls(page)).toEqual(release ? ['checkUpdate', 'downloadUpdate'] : ['checkUpdate']);
  if (settings) {
    await page.keyboard.press('ContextMenu');
    await expect(page.getByRole('heading', { name: '电视设置', exact: true })).toBeVisible();
  }
}

const calls = (page: Page) => page.evaluate(() => (window as any).updateCalls as string[]);
const progress = (page: Page, detail: object) => page.evaluate(async detail => {
  window.dispatchEvent(new CustomEvent('molly:clientUpdateProgress', { detail }));
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}, detail);

test('startup checks and downloads without changing the page or focus', async ({ page }) => {
  await setup(page, { settings: false });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:clientUpdateAvailable')));
  expect(await calls(page)).toEqual(['checkUpdate', 'downloadUpdate']);
  await progress(page, { state: 'downloaded' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-focus="series-maisy"]')).toBeFocused();
  await expect(page.getByRole('button', { name: '立即安装', exact: true })).toHaveCount(0);
  await page.keyboard.press('ContextMenu');
  await expect(page.getByRole('heading', { name: '电视设置', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '立即安装', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: '立即更新', exact: true })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect.poll(() => calls(page)).toEqual(['checkUpdate', 'downloadUpdate', 'installUpdate']);
});

test('settings show background progress and focus Install after download verification', async ({ page }) => {
  await setup(page);
  const software = page.getByRole('region', { name: '软件更新' });
  const action = page.locator('[data-focus="client-update-action"]');
  await expect(software.getByRole('heading', { name: '软件更新', exact: true })).toHaveCount(0);
  await expect(software).toContainText('当前版本 0.1.8');
  await expect(software.getByRole('heading', { name: '本次更新' })).toBeVisible();
  await expect(software.getByRole('status')).toHaveText('正在下载 0%');
  await expect(action).toHaveCount(0);
  await expect(page.getByRole('button', { name: '检查客户端更新' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '返回媒体库' })).toHaveCount(0);
  await progress(page, { state: 'downloading', received: 75, total: 100 });
  await expect(software.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75');
  await expect(software.getByRole('status')).toHaveText('正在下载 75%');
  await progress(page, { state: 'downloading', received: 100, total: 100 });
  await expect(software.getByRole('status')).toHaveText('正在准备安装…');
  await expect(action).toHaveCount(0);
  await progress(page, { state: 'downloaded' });
  await expect(action).toHaveText('立即安装');
  await expect(action).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-focus="subtitle-default"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(action).toBeFocused();
  await page.screenshot({ path: '/tmp/molly-tv-update-ready.png' });
  await page.keyboard.press('Enter');
  await expect.poll(() => calls(page)).toEqual(['checkUpdate', 'downloadUpdate', 'installUpdate']);
});

test('opening settings again reuses the startup result without another check', async ({ page }) => {
  await setup(page, { release: false });
  await expect(page.getByRole('status')).toHaveText('当前已是最新版本');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="series-maisy"]')).toBeFocused();
  await page.keyboard.press('ContextMenu');
  await expect(page.getByRole('status')).toHaveText('当前已是最新版本');
  expect(await calls(page)).toEqual(['checkUpdate']);
});

test('failed automatic download offers one retry without invoking installation', async ({ page }) => {
  await setup(page, { failDownload: true });
  await expect(page.getByRole('status')).toHaveText('下载失败，请重试');
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => calls(page)).toEqual(['checkUpdate', 'downloadUpdate', 'downloadUpdate']);
  await expect(page.getByRole('status')).toHaveText('正在下载 0%');
  await expect(page.getByRole('button', { name: '立即安装', exact: true })).toHaveCount(0);
});

test('settings remain usable at 720p', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await setup(page);
  await progress(page, { state: 'downloaded' });
  await expect(page.getByRole('button', { name: '立即安装', exact: true })).toBeFocused();
  await expect(page.locator('[data-focus="client-update-action"]')).toBeInViewport();
  await expect(page.locator('[data-focus="subtitle-default"]')).toBeInViewport();
  await page.screenshot({ path: '/tmp/molly-tv-update-720p.png' });
});


test('a completed background download stays silent during and after playback', async ({ page }) => {
  await setup(page, { settings: false });
  await page.locator('[data-focus="series-maisy"]').click();
  await expect(page.locator('.player-status')).toBeVisible();
  await progress(page, { state: 'downloaded' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:playbackClosed')));
  await expect(page.locator('.player-status')).toHaveCount(0);
  await expect(page.locator('[data-focus="series-maisy"]')).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('ContextMenu');
  await expect(page.getByRole('button', { name: '立即安装', exact: true })).toBeFocused();
  expect(await calls(page)).toEqual(['checkUpdate', 'downloadUpdate']);
});
