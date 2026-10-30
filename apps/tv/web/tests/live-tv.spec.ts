import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page, { enabled = true, liveTv = true } = {}) {
  await page.addInitScript(({ enabled, liveTv }) => {
    const w = window as any;
    w.liveCalls = [];
    w.liveTvResponses = 0;
    w.MollyBridge = { postMessage(raw: string) {
      const { id, method, args } = JSON.parse(raw);
      let result: any = { ok: true };
      if (method === 'getCapabilities') result = { bridgeVersion: 1, authenticated: true, nativePlayback: true, liveTv, serverUrl: 'https://media.test' };
      if (method === 'request') {
        if (args.path.startsWith('/api/home')) result = { rows: [{ title: '媒体库', items: [{ id: 'one', name: '测试视频' }] }] };
        if (args.path === '/api/families/me/children') result = [];
        if (args.path === '/api/settings/playback') result = { defaultSubtitle: 'zh' };
        if (args.path === '/api/live-tv') result = { enabled, channels: enabled ? Array.from({ length: 30 }, (_, i) => ({ id: String(i).padStart(32, '0'), name: `测试频道 ${i + 1}`, group: i < 25 ? '央视' : '地方台' })) : [] };
      }
      if (method === 'playLiveChannel') w.liveCalls.push(args);
      setTimeout(() => {
        w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) });
        if (method === 'request' && args.path === '/api/live-tv') w.liveTvResponses++;
      }, 5);
    } };
  }, { enabled, liveTv });
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-one"]')).toBeFocused();
  await page.keyboard.press('ContextMenu');
  if (!enabled) {
    await expect.poll(() => page.evaluate(() => (window as any).liveTvResponses)).toBe(1);
    return;
  }
  await page.getByRole('button', { name: /电视直播（实验）/ }).click();
  await expect(page.getByRole('heading', { name: '电视直播（实验）' })).toBeVisible();
  await expect(page.locator('[data-focus="live-refresh"]')).toBeFocused();
}

test('settings entry opens paginated channels; native playback returns to the selected channel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await setup(page);
  await expect(page.locator('.live-channel')).toHaveCount(24);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.locator('.live-channel')).toHaveCount(6);
  const channel = page.getByRole('button', { name: '测试频道 25 央视' });
  await channel.click();
  await expect.poll(() => page.evaluate(() => (window as any).liveCalls.length)).toBe(1);
  await expect(page.getByRole('status', { name: '' }).filter({ hasText: '正在打开直播播放器' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:livePlaybackClosed')));
  await expect(channel).toBeFocused();
  await page.screenshot({ path: '/tmp/molly-live-tv-720p.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '电视设置', exact: true })).toBeVisible();
  await expect(page.locator('[data-focus="open-live-tv"]')).toBeFocused();
});

test('operator-disabled live TV hides the settings entry', async ({ page }) => {
  await setup(page, { enabled: false });
  await expect(page.getByRole('heading', { name: '电视设置', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /电视直播（实验）/ })).toHaveCount(0);
  await expect(page.locator('input')).toHaveCount(0);
  await expect(page.locator('.live-channel')).toHaveCount(0);
});

test('old APK requests an update instead of invoking an unsupported bridge method', async ({ page }) => {
  await setup(page, { liveTv: false });
  await page.getByRole('button', { name: '测试频道 1 央视', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('请更新电视客户端后观看直播');
  expect(await page.evaluate(() => (window as any).liveCalls.length)).toBe(0);
});

test('remote selects a channel group and navigates the resulting grid', async ({ page }) => {
  await setup(page);
  await page.getByRole('combobox', { name: '频道分组' }).click();
  await page.getByRole('option', { name: '地方台', exact: true }).click();
  await expect(page.locator('.live-channel')).toHaveCount(5);
  await page.locator('.live-channel').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: '测试频道 27 地方台' })).toBeFocused();
});

test('browser playback reports stop on exit and restores channel focus after a stream failure', async ({ page }) => {
  const events: any[] = [];
  await page.addInitScript(() => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify({ accessToken: 'test', refreshToken: 'test', deviceId: 'tv' })));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    let data: any = {};
    if (path === '/api/me') data = { id: 'user', familyId: 'family' };
    if (path === '/api/home') data = { rows: [{ title: '媒体库', items: [{ id: 'one', name: '测试视频' }] }] };
    if (path === '/api/families/me/children') data = [];
    if (path === '/api/settings/playback') data = { defaultSubtitle: 'zh' };
    if (path === '/api/live-tv') data = { enabled: true, channels: [{ id: 'one', name: '测试直播', group: '测试' }] };
    if (path === '/api/live-tv/channels/one/sessions') data = { sessionId: 'session', url: 'https://video.example.test/live.mp4', name: '测试直播', limitMs: 1800000 };
    if (path === '/api/live-tv/sessions/session') data = { ok: true };
    if (path === '/api/playback/sessions/session/events') { events.push(route.request().postDataJSON()); data = { ok: true }; }
    return route.fulfill({ json: data });
  });
  await page.route('https://video.example.test/**', route => route.abort());
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-one"]')).toBeFocused();
  await page.keyboard.press('ContextMenu');
  await page.getByRole('button', { name: /电视直播（实验）/ }).click();
  await page.getByRole('button', { name: '测试直播 测试' }).click();
  await expect(page.getByRole('dialog', { name: '直播 · 测试直播' })).toBeVisible();
  await expect(page.locator('.live-player [role="alert"]')).toContainText('频道暂时无法播放');
  await page.keyboard.press('Escape');
  await expect(page.locator('.live-player')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '测试直播 测试' })).toBeFocused();
  await expect.poll(() => events.some(event => event.stopped === true)).toBe(true);
  expect(events.every(event => event.playedMs === 0)).toBe(true);
});
