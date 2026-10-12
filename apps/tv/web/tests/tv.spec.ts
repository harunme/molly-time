import { test, expect } from '@playwright/test';

test('remote navigation, playback return, folder restoration and durable binding settings', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      MollyBridge: { postMessage: (message: string) => void; onmessage?: (e: { data: string }) => void };
      playbackId: string;
    };
    w.MollyBridge = { postMessage(raw: string) {
      const { id, method, args } = JSON.parse(raw);
      let result: unknown = { ok: true };
      if (method === 'getCapabilities') result = { bridgeVersion: 1, authenticated: true, childId: '', nativePlayback: true };
      if (method === 'request') {
        const path = args.path;
        if (path === '/api/home') result = { rows: [{ title: '宝宝课堂', items: [
          { id: 's1', name: '动物小故事', episodeCount: 2 }, { id: 's2', name: '一起学颜色', episodeCount: 3 },
        ] }] };
        if (path === '/api/families/me/children') result = [{ id: 'c1', name: '小朋友' }];
        if (path === '/api/series/s2/playlist') result = { episodeId: 'e1', episodes: [
          { id: 'e1', name: '红色在哪里', runtimeMs: 120000 }, { id: 'e2', name: '蓝色的天空', runtimeMs: 180000 },
        ] };
      }
      if (method === 'playEpisode') w.playbackId = args.episodeId;
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
    } };
  });
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-s1"]')).toBeFocused();
  await expect(page.locator('.sidebar')).toBeHidden();
  expect(await page.locator('.content-shell').evaluate((node) => node.getBoundingClientRect().left)).toBe(0);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-focus="back"]')).toBeFocused();
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="series-s1"]')).toBeFocused();
  await expect(page.locator('.sidebar')).toBeHidden();

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="series-s2"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="episode-e1"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="episode-e2"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { playbackId: string }).playbackId)).toBe('e2');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:playbackClosed')));
  await expect(page.locator('[data-focus="episode-e2"]')).toBeFocused();
  await expect(page.locator('.player-status')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/tv-episodes.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="series-s2"]')).toBeFocused();
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: '选择儿童' }).click();
  await page.getByRole('button', { name: '小朋友' }).click();
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出账号' })).toHaveCount(0);
  await page.getByRole('button', { name: '重新配对', exact: true }).click();
  await expect(page.getByRole('heading', { name: '重新配对？' })).toBeVisible();
  await expect(page.locator('[data-focus="cancel-re-pair"]')).toBeFocused();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('[data-focus="re-pair"]')).toBeFocused();
  await page.getByRole('button', { name: '返回媒体库' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.poster').first()).toBeVisible();
});

test('TV starts at home, pairs without a password, renews expired codes and opens content', async ({ page }) => {
  let started = 0;
  await page.route('**/api/auth/pairing/start', (route) => route.fulfill({ json: {
    deviceCode: 'test-device-secret-' + String(++started).padEnd(32, '0'),
    userCode: started === 1 ? '0123' : '4567',
    verificationUri: 'http://127.0.0.1:8096/manage/?pair=0123', verificationUriManual: 'http://127.0.0.1:8096/manage/',
    expiresAt: new Date(Date.now() + 600000).toISOString(), interval: 3,
  } }));
  await page.route('**/api/auth/pairing/cancel', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/auth/pairing/poll', (route) => route.fulfill({ json: started === 1 ? { status: 'expired' } :
    { status: 'authorized', auth: { accessToken: 'test', refreshToken: 'refresh', deviceId: 'device-1' } } }));
  await page.route('**/api/home', (route) => route.fulfill({ json: { rows: [] } }));
  await page.route('**/api/families/me/children', (route) => route.fulfill({ json: [] }));
  await page.goto('/tv/');
  await expect(page.getByRole('navigation', { name: '电视导航', includeHidden: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '打开菜单' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '绑定家庭媒体库' }).click();
  await expect(page.locator('.pairing-code')).toHaveText('0123');
  await expect(page.getByLabel('密码')).toHaveCount(0);
  await expect(page.getByLabel('账号', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('img', { name: '电视绑定二维码' })).toHaveCount(0);
  await expect(page.getByText('配对码已过期，请重新生成')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: '重新生成配对码' }).click();
  await expect(page.locator('.pairing-code')).toHaveText('4567');
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10000 });
  await expect(page.getByText('媒体库还没有内容')).toBeVisible();
  await page.reload();
  await expect(page.getByText('媒体库还没有内容')).toBeVisible();
  await expect(page.getByRole('button', { name: '绑定家庭媒体库' })).toHaveCount(0);
  await page.unroute('**/api/home');
  await page.route('**/api/home', (route) => route.fulfill({ status: 503, json: { detail: 'Temporary outage' } }));
  await page.reload();
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('mollytime.tv.binding.v1'))).not.toBeNull();
});

test('re-pair confirmation retains binding on failure and opens a new code only after reset', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify({
    accessToken: 'cached-access', refreshToken: 'cached-device', deviceId: 'device-1', childId: 'c1',
  })));
  await page.route('**/api/home', (route) => route.fulfill({ json: { rows: [] } }));
  await page.route('**/api/families/me/children', (route) => route.fulfill({ json: [] }));
  let attempts = 0;
  await page.route('**/api/auth/pairing/reset', (route) => route.fulfill({ status: ++attempts === 1 ? 503 : 200, json: { ok: true } }));
  await page.route('**/api/auth/pairing/start', (route) => route.fulfill({ json: {
    deviceCode: 'next-pairing-secret'.padEnd(43, '0'), userCode: '0123', interval: 3,
    expiresAt: new Date(Date.now() + 600000).toISOString(), verificationUri: '/manage/?pair=0123',
    verificationUriManual: '/manage/',
  } }));
  await page.goto('/tv/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '重新配对', exact: true }).click();
  expect(attempts).toBe(0);
  await page.getByRole('button', { name: '确认重新配对' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('mollytime.tv.binding.v1'))).not.toBeNull();
  await page.getByRole('button', { name: '确认重新配对' }).click();
  await expect(page.getByRole('heading', { name: '绑定电视' })).toBeVisible();
  await expect(page.locator('.pairing-code')).toHaveText('0123');
  expect(await page.evaluate(() => localStorage.getItem('mollytime.tv.binding.v1'))).toBeNull();
});

test('independent TV rails, remembered row focus and modal boundaries', async ({ page }) => {
  await page.addInitScript(() => {
    let removedAfterPlayback = false;
    const w = window as unknown as { MollyBridge: { postMessage: (raw: string) => void; onmessage?: (event: { data: string }) => void } };
    w.MollyBridge = { postMessage(raw) {
      const { id, method, args } = JSON.parse(raw);
      let result: unknown = { ok: true };
      if (method === 'getCapabilities') result = { bridgeVersion: 1, authenticated: true, childId: 'c1', nativePlayback: true };
      if (method === 'request' && args.path === '/api/families/me/children') result = [{ id: 'c1', name: '小米' }, { id: 'c2', name: '小麦' }];
      if (method === 'request' && args.path === '/api/home') result = { rows: ['今晚一起看', '发现新故事', '继续观看'].map((title, row) => ({ title,
        items: Array.from({ length: 12 }, (_, i) => ({ id: `s${i + 1}`, name: `${['自然小课堂', '奇妙动物', '一起学英语'][row]} ${i + 1}`, episodeCount: 12 + i,
          ...(row === 2 ? { type: 'episode', runtimeMs: 180000 } : {}) })).filter((item) => !removedAfterPlayback || item.id !== 's10') })) };
      if (method === 'playEpisode') removedAfterPlayback = true;
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
    } };
  });
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-s1"]')).toBeFocused();
  const heroY = await page.locator('.feature').evaluate((node) => node.getBoundingClientRect().top);
  const firstRail = page.locator('[data-rail="home-row-0"]');
  await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('[data-rail="home-row-0"]')!;
    const trace: number[] = [];
    (window as unknown as { motionTrace: number[] }).motionTrace = trace;
    window.addEventListener('keydown', () => {
      trace.push(rail.scrollLeft);
      const started = performance.now();
      const sample = () => {
        trace.push(rail.scrollLeft);
        if (performance.now() - started < 350) requestAnimationFrame(sample);
        else (window as unknown as { motionComplete: boolean }).motionComplete = true;
      };
      requestAnimationFrame(sample);
    }, { once: true, capture: true });
  });
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => (window as unknown as { motionComplete: boolean }).motionComplete)).toBe(true);
  const trace = await page.evaluate(() => (window as unknown as { motionTrace: number[] }).motionTrace);
  expect(trace[0]).toBe(0);
  expect(trace.at(-1)).toBeGreaterThan(trace[0]);
  expect(trace.some((value) => value > trace[0] && value < trace.at(-1)!)).toBe(true);
  for (let index = 0; index < 8; index++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="series-s10"]')).toBeFocused();
  await expect.poll(() => firstRail.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await expect(page.locator('.feature h1')).toHaveText('自然小课堂 10');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.locator('[data-rail="home-row-1"] .focused').count()).toBe(1);
  await page.keyboard.press('ArrowRight');
  const secondFocus = await page.locator('[data-rail="home-row-1"] .focused').getAttribute('data-focus');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-focus="series-s10"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`[data-focus="${secondFocus}"]`)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.locator('[data-rail="home-row-2"] .focused').count()).toBe(1);
  await expect.poll(() => page.locator('.shelves-scroll').evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator('.feature').evaluate((node) => node.getBoundingClientRect().top)).toBe(heroY);
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
  const returnFocus = await page.locator('[data-rail="home-row-2"] .focused').getAttribute('data-focus');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('[data-focus="connection"]')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => page.locator('[role="dialog"] .focused').count()).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="settings"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(`[data-focus="${returnFocus}"]`)).toBeFocused();
  await page.screenshot({ path: 'test-results/tv-rails.png' });
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: '小米', exact: true }).click();
  await expect(page.locator('[data-focus="child-c1"]')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-focus="child-c1"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="child-c2"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.viewer strong')).toHaveText('小麦');
  await expect(page.locator('[data-focus="series-s1"]')).toBeFocused();
  await page.setViewportSize({ width: 960, height: 540 });
  await page.screenshot({ path: 'test-results/tv-960.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 3840, height: 2160 });
  await page.screenshot({ path: 'test-results/tv-4k.png' });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.locator('[data-focus="home-2-s10"]').click();
  await expect(page.getByRole('status')).toContainText('正在打开播放器');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:playbackClosed')));
  await expect(page.locator('[data-focus="home-2-s10"]')).toHaveCount(0);
  await expect(page.locator('[data-focus="series-s1"]')).toBeFocused();
  await expect(page.locator('[data-focus="series-s1"]')).toBeInViewport();
  expect(await page.locator('.shelves-scroll').evaluate((node) => node.scrollTop)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-focus="series-s1"]')).toHaveCSS('transform', 'none');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="series-s2"]')).toBeFocused();
  expect(await firstRail.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
});

test('real covers settle after fast navigation, resume progress and flat folders', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify({
    accessToken: 'presentation-access', refreshToken: 'presentation-refresh', deviceId: 'device', childId: 'child',
  })));
  const heroRequests: string[] = [];
  await page.route('**/api/me', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/families/me/children', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/home', (route) => route.fulfill({ json: { rows: [{ title: '继续观看', items: [
    { id: 'a', name: '第一集', type: 'episode', positionMs: 30000, runtimeMs: 120000, image: { url: '/api/items/a/image?v=first' } },
    { id: 'b', name: '第二集', type: 'episode', positionMs: 10, runtimeMs: 0, image: { url: '/api/items/b/image' } },
    { id: 'c', name: '自然课堂', episodeCount: 1, image: { url: '/api/items/c/image?v=third' } },
  ] }] } }));
  await page.route('**/api/items/*/image?*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('w') === '960') heroRequests.push(url.pathname);
    const width = url.pathname.includes('/c/') ? 720 : 640;
    return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="360"><rect width="100%" height="100%" fill="#446655"/></svg>` });
  });
  await page.route('**/api/series/c/playlist', (route) => route.fulfill({ json: { episodeId: 'ready', episodes: [
    { id: 'ready', name: '动物', runtimeMs: 60000, image: { url: '/api/items/c/image?v=third' } },
  ] } }));
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-a"]')).toBeFocused();
  await expect(page.getByRole('progressbar', { name: '观看进度' })).toHaveAttribute('aria-valuenow', '25');
  await expect(page.locator('.feature-art img')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.feature h1')).toHaveText('自然课堂');
  await expect.poll(() => page.locator('.feature-art img').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(720);
  expect(heroRequests).not.toContain('/api/items/b/image');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="episode-ready"]')).toBeFocused();
  await expect(page.locator('[data-focus="season-empty"]')).toHaveCount(0);
  await expect(page.getByText('0 集', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-focus="episode-ready"] .cover img')).toBeVisible();
});
