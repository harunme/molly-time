import { expect, test } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const w = window as any;
    w.MollyBridge = { postMessage(raw: string) {
      const { id, method, args } = JSON.parse(raw);
      let result: any = { ok: true };
      if (method === 'getCapabilities') result = { bridgeVersion: 1, serverUrl: 'https://media.test', authenticated: true, nativePlayback: true, clientUpdates: true, shellVersion: '0.1.8' };
      if (method === 'request') {
        if (args.path.startsWith('/api/home')) result = { rows: [{ id: 'library', title: '我的媒体库', items: [{ id: 'maisy', name: 'Maisy Mouse', episodeCount: 80 }] }] };
        if (args.path === '/api/settings/playback') result = { defaultSubtitle: 'en' };
        if (args.path === '/api/families/me/children') result = [];
      }
      if (method === 'checkUpdate') result = { release: { versionName: '0.1.9', size: 9 * 1024 * 1024, notes: '未加载完的文件夹不再显示为空。\n修复有网络时未缓存视频无法播放的问题。' } };
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
    } };
  });
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-maisy"]')).toBeFocused();
  await page.keyboard.press('ContextMenu');
  await expect(page.locator('[data-focus="re-pair"]')).toBeFocused();
  await expect(page.getByRole('button', { name: '检查客户端更新' })).toHaveCount(0);
  await expect(page.getByText('发现新版本 0.1.9')).toBeVisible();
}

test('release notes are grouped with update actions and remote focus matches the other controls', async ({ page }) => {
  await setup(page);
  const software = page.getByRole('region', { name: '软件更新' });
  const action = page.locator('[data-focus="client-update-action"]');
  await expect(software.getByRole('heading', { name: '本次更新' })).toBeVisible();
  await expect(software.getByRole('button', { name: '立即更新' })).toBeVisible();
  await expect(software.getByRole('region', { name: '默认字幕' })).toHaveCount(0);
  await expect(page.locator('[data-focus="subtitle-default"]')).toBeVisible();
  await expect(page.getByRole('button', { name: '返回媒体库' })).toHaveCount(0);
  const focusStyle = (node: Element) => {
    const style = getComputedStyle(node);
    return { border: style.borderTopColor, shadow: style.boxShadow };
  };
  const reference = await page.locator('[data-focus="re-pair"]').evaluate(focusStyle);
  const rest = await action.evaluate(node => ({ fill: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).borderTopColor }));
  await page.screenshot({ path: '/tmp/molly-tv-update-available.png' });
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-focus="subtitle-default"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(action).toBeFocused();
  expect(await action.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(rest.fill);
  expect((await action.evaluate(focusStyle)).border).not.toBe(rest.border);
  expect(await action.evaluate(focusStyle)).toEqual(reference);
  await page.screenshot({ path: '/tmp/molly-tv-update-selected.png' });
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:clientUpdateProgress', { detail: { state: 'downloading', received: 75, total: 100 } })));
  await expect(software.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75');
  await expect(software.getByRole('status')).toHaveText('正在下载 75%');
  await expect.poll(() => software.locator('.update-progress').evaluate(node => node.firstElementChild!.getBoundingClientRect().width / node.getBoundingClientRect().width)).toBeCloseTo(.75, 2);
  await expect(action).toHaveCount(0);
  await page.screenshot({ path: '/tmp/molly-tv-update-downloading.png' });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:clientUpdateProgress', { detail: { state: 'downloaded' } })));
  await expect(action).toHaveText('立即安装');
  await expect(page.locator('[data-focus="re-pair"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-focus="subtitle-default"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(action).toBeFocused();
  await page.screenshot({ path: '/tmp/molly-tv-update-ready.png' });
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-focus="subtitle-default"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-focus="re-pair"]')).toBeFocused();
});

test('settings remain usable at 720p', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await setup(page);
  await expect(page.locator('[data-focus="client-update-action"]')).toBeInViewport();
  await expect(page.locator('[data-focus="subtitle-default"]')).toBeInViewport();
  await expect(page.getByRole('button', { name: '返回媒体库' })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/molly-tv-update-720p.png' });
});
