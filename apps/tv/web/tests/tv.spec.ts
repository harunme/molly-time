import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/me', (route) => route.fulfill({ json: {} }));
});

for (const supported of [true, false]) {
  test(`client update setting respects native capability: ${supported}`, async ({ page }) => {
    await page.addInitScript((supportsUpdates) => {
      const w = window as unknown as {
        updateChecks: number;
        MollyBridge: { postMessage: (raw: string) => void; onmessage?: (event: { data: string }) => void };
      };
      w.updateChecks = 0;
      w.MollyBridge = { postMessage(raw) {
        const { id, method, args } = JSON.parse(raw);
        let result: unknown = { ok: true };
        if (method === 'getCapabilities') result = { bridgeVersion: 1, serverUrl: 'https://media.example.test', authenticated: true, childId: '', nativePlayback: true, clientUpdates: supportsUpdates, shellVersion: '0.4.0' };
        if (method === 'request' && args.path.split('?')[0] === '/api/home') result = { rows: [{ title: '媒体库', items: [{ id: 'story', name: '故事', episodeCount: 1 }] }] };
        if (method === 'request' && args.path === '/api/families/me/children') result = [];
        if (method === 'checkUpdate') { w.updateChecks++; result = { release: { versionName: '0.5.0', size: 2097152, notes: '网页显示更新说明' } }; }
        setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      } };
    }, supported);
    await page.goto('/tv/');
    await expect(page.locator('[data-focus="series-story"]')).toBeFocused();
    await page.keyboard.press('ContextMenu');
    await expect(page.getByRole('button', { name: /检查网页更新/ })).toHaveCount(0);
    await expect(page.locator('[data-focus="check-web-update"]')).toHaveCount(0);
    await expect(page.locator(`[data-focus="${supported ? 'check-update' : 're-pair'}"]`)).toBeFocused();
    await expect(page.getByRole('button', { name: /连接设置/ })).toHaveCount(0);
    if (supported) {
      await expect(page.getByRole('region', { name: '软件更新' })).toContainText('当前版本 0.4.0');
      await expect(page.locator('[data-focus="check-update"]')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => (window as unknown as { updateChecks: number }).updateChecks)).toBe(1);
      await expect(page.getByRole('heading', { name: '电视设置' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '客户端更新' })).toHaveCount(0);
      await expect(page.getByText('发现新版本 0.5.0')).toBeVisible();
      await expect(page.getByText('网页显示更新说明')).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await expect(page.locator('[data-focus="check-update"]')).toBeFocused();
      await expect(page.getByRole('button', { name: '返回设置' })).toHaveCount(0);
      // Notifications during an inline check must also stay in settings.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:clientUpdateAvailable')));
      await expect(page.getByRole('heading', { name: '电视设置' })).toBeVisible();
      await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true })));
      await expect(page.getByRole('heading', { name: '电视设置' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('[data-focus="series-story"]')).toBeFocused();
      await page.keyboard.press('ContextMenu');
      await expect(page.getByText('发现新版本 0.5.0')).toBeVisible();
      await page.evaluate(() => window.mollyBack?.());
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('[data-focus="series-story"]')).toBeFocused();
      // A direct update notification has no settings page to return to.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:clientUpdateAvailable', {
        detail: { versionName: '0.5.0', size: 2097152, notes: '网页显示更新说明' },
      })));
      await expect(page.getByRole('heading', { name: '客户端更新' })).toBeVisible();
      await expect(page.getByRole('button', { name: '返回设置' })).toHaveCount(0);
      await page.getByRole('button', { name: '返回媒体库' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('[data-focus="series-story"]')).toBeFocused();
    } else await expect(page.locator('[data-focus="check-update"]')).toHaveCount(0);
  });
}

test('fresh older shell connects to the official service without an address form', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      connectedServer: string;
      MollyBridge: { postMessage: (raw: string) => void; onmessage?: (event: { data: string }) => void };
    };
    w.connectedServer = '';
    w.MollyBridge = { postMessage(raw) {
      const { id, method, args } = JSON.parse(raw);
      let result: unknown = { ok: true };
      if (method === 'getCapabilities') result = { bridgeVersion: 1, serverUrl: '', authenticated: false, childId: '', nativePlayback: true, devicePairing: true };
      if (method === 'connect') { w.connectedServer = args.serverUrl; result = { serverUrl: args.serverUrl, authenticated: false, childId: '' }; }
      if (method === 'pairingStart') result = { userCode: '0123', expiresAt: new Date(Date.now() + 600000).toISOString(), interval: 3 };
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 1);
    } };
  });
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="connect-home"]')).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { connectedServer: string }).connectedServer)).toBe('https://mollytime.app');
  await expect(page.getByRole('button', { name: '设置媒体库地址' })).toHaveCount(0);
  await expect(page.locator('#server-address')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.locator('.pairing-code')).toHaveText('0123');
  await expect(page.getByRole('button', { name: /连接设置/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="connect-home"]')).toBeFocused();
  await page.keyboard.press('ContextMenu');
  await page.locator('[data-focus="connect-account"]').click();
  await expect(page.getByRole('heading', { name: '绑定电视' })).toBeVisible();
  await page.getByRole('button', { name: '返回设置' }).click();
  await expect(page.getByRole('heading', { name: '电视设置' })).toBeVisible();
  await expect(page.locator('[data-focus="connect-account"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '绑定电视' })).toBeVisible();
  await page.evaluate(() => window.mollyBack?.());
  await expect(page.locator('[data-focus="connect-account"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-focus="connect-home"]')).toBeFocused();
});

test('recent playback precedes library and supports remote playback and return', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      MollyBridge: { postMessage: (message: string) => void; onmessage?: (e: { data: string }) => void };
      playbackId: string;
    };
    w.MollyBridge = { postMessage(raw) {
      const { id, method, args } = JSON.parse(raw);
      let result: unknown = { ok: true };
      if (method === 'getCapabilities') result = { bridgeVersion: 1, authenticated: true, childId: 'c1', nativePlayback: true };
      if (method === 'request' && args.path === '/api/families/me/children') result = [{ id: 'c1', name: '小朋友' }];
      if (method === 'request' && args.path.split('?')[0] === '/api/home') result = { rows: [
        { title: '最近播放', items: [
          { id: 'recent', name: '最近的视频', type: 'episode', runtimeMs: 120000, positionMs: 30000, completed: false },
          { id: 'finished', name: '播完的视频', type: 'episode', runtimeMs: 120000, positionMs: 120000, completed: true },
        ] },
        { title: '我的媒体库', items: [{ id: 'folder', name: '测试', episodeCount: 2 }] },
      ] };
      if (method === 'playEpisode') w.playbackId = args.episodeId;
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
    } };
  });
  await page.goto('/tv/');
  await expect(page.locator('.shelf-heading h2')).toHaveText(['最近播放', '我的媒体库']);
  await expect(page.locator('.home-greeting h1')).toHaveText(/^(早上好|下午好|晚上好)$/);
  await expect(page.getByRole('region', { name: '文件夹详情' })).toHaveCount(0);
  const recent = page.locator('[data-focus="series-recent"]');
  await expect(recent).toBeFocused();
  await expect(recent.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  await expect(recent.locator('.cover-action')).toContainText('继续观看 · 已看 00:30 / 02:00');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-focus="home-1-folder"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(recent).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="series-finished"]')).toBeFocused();
  await expect(page.locator('[data-focus="series-finished"] .cover')).toContainText('再次播放');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { playbackId: string }).playbackId)).toBe('finished');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:playbackClosed')));
  await expect(page.locator('[data-focus="series-finished"]')).toBeFocused();
});

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
        const path = args.path.split('?')[0];
        if (path === '/api/home') result = { rows: [{ title: '宝宝课堂', items: [
          { id: 's1', name: '动物小故事', episodeCount: 2 }, { id: 's2', name: '一起学颜色', episodeCount: 3 },
        ] }] };
        if (path === '/api/families/me/children') result = [{ id: 'c1', name: '小朋友' }];
        if (path === '/api/series/s2/playlist') result = { total: 2, items: [{ id: 'e1', name: '红色在哪里', type: 'episode', runtimeMs: 120000 }, { id: 'e2', name: '蓝色的天空', type: 'episode', runtimeMs: 180000 }], itemTotal: 2, itemsHasMore: false, episodeId: 'e1', episodes: [
          { id: 'e1', name: '红色在哪里', runtimeMs: 120000 }, { id: 'e2', name: '蓝色的天空', runtimeMs: 180000 },
        ] };
      }
      if (method === 'playEpisode') w.playbackId = args.episodeId;
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
    } };
  });
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-s1"]')).toBeFocused();
  await expect(page.locator('.home-greeting h1')).toHaveText(/^(早上好|下午好|晚上好)$/);
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开菜单' })).toHaveCount(0);
  expect(await page.locator('.content-shell').evaluate((node) => node.getBoundingClientRect().left)).toBe(0);
  await expect(page.getByRole('button', { name: '设置', exact: true })).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-focus="series-s1"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-focus="series-s1"]')).toBeFocused();

  await page.keyboard.press('ContextMenu');
  await expect(page.getByRole('heading', { name: '电视设置' })).toBeVisible();
  await expect(page.locator('[data-focus="re-pair"]')).toBeFocused();
  await expect(page.getByRole('button', { name: /连接设置/ })).toHaveCount(0);
  await page.keyboard.press('ContextMenu');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="series-s1"]')).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="series-s2"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="episode-e1"]')).toBeFocused();
  await expect(page.locator('.home-greeting')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '文件夹详情' }).getByRole('heading')).toHaveText('一起学颜色');
  await expect(page.locator('.detail-count')).toHaveText('2 个视频');
  await expect(page.locator('.detail-art')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="episode-e2"]')).toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:menu')));
  await expect(page.locator('[data-focus="re-pair"]')).toBeFocused();
  await expect(page.getByRole('button', { name: /连接设置/ })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:menu')));
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="episode-e2"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { playbackId: string }).playbackId)).toBe('e2');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:menu')));
  await expect(page.getByRole('heading', { name: '电视设置' })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:playbackClosed')));
  await expect(page.locator('[data-focus="episode-e2"]')).toBeFocused();
  await expect(page.locator('.player-status')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/tv-episodes.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="series-s2"]')).toBeFocused();
  await expect(page.locator('.home-greeting')).toBeVisible();
  await expect(page.locator('.profile-trigger')).toHaveCount(0);
  await page.keyboard.press('ContextMenu');
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
  await page.route('**/api/home**', (route) => route.fulfill({ json: { rows: [] } }));
  await page.route('**/api/families/me/children', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/settings/playback', (route) => route.fulfill({ json: { defaultSubtitle: 'zh' } }));
  await page.goto('/tv/');
  await expect(page.getByRole('navigation', { name: '电视导航', includeHidden: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '设置', exact: true })).toHaveCount(0);
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
  await page.unroute('**/api/home**');
  await page.route('**/api/home**', (route) => route.fulfill({ status: 503, json: { detail: 'Temporary outage' } }));
  await page.reload();
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('mollytime.tv.binding.v1'))).not.toBeNull();
});

test('re-pair confirmation retains binding on failure and opens a new code only after reset', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify({
    accessToken: 'cached-access', refreshToken: 'cached-device', deviceId: 'device-1', childId: 'c1',
  })));
  await page.route('**/api/home**', (route) => route.fulfill({ json: { rows: [] } }));
  await page.route('**/api/families/me/children', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/settings/playback', (route) => route.fulfill({ json: { defaultSubtitle: 'zh' } }));
  let attempts = 0;
  await page.route('**/api/auth/pairing/reset', (route) => route.fulfill({ status: ++attempts === 1 ? 503 : 200, json: { ok: true } }));
  await page.route('**/api/auth/pairing/start', (route) => route.fulfill({ json: {
    deviceCode: 'next-pairing-secret'.padEnd(43, '0'), userCode: '0123', interval: 3,
    expiresAt: new Date(Date.now() + 600000).toISOString(), verificationUri: '/manage/?pair=0123',
    verificationUriManual: '/manage/',
  } }));
  await page.goto('/tv/');
  await expect(page.locator('[data-focus-region="screen"]')).toBeVisible();
  await expect(page.getByText('正在加载内容…', { exact: true })).toHaveCount(0);
  await page.keyboard.press('ContextMenu');
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
      if (method === 'request' && args.path.split('?')[0] === '/api/home') result = { rows: ['今晚一起看', '发现新故事', '继续观看'].map((title, row) => ({ title,
        items: Array.from({ length: 12 }, (_, i) => ({ id: `s${i + 1}`, name: `${['自然小课堂', '奇妙动物', '一起学英语'][row]} ${i + 1}`, episodeCount: 12 + i,
          ...(row === 2 ? { type: 'episode', runtimeMs: 180000 } : {}) })).filter((item) => !removedAfterPlayback || item.id !== 's10') })) };
      if (method === 'playEpisode') removedAfterPlayback = true;
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
    } };
  });
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-s1"]')).toBeFocused();
  await expect(page.getByRole('region', { name: '选中内容预览' })).toHaveCount(0);
  const navigationY = await page.locator('.topbar').evaluate((node) => node.getBoundingClientRect().top);
  const firstRail = page.locator('[data-rail="home-row-0"]');
  const initiallyVisible = await firstRail.evaluate((rail) => Array.from(rail.querySelectorAll<HTMLElement>('button[data-focus]'))
    .filter((card) => card.offsetLeft + card.offsetWidth <= rail.clientWidth - 20).length);
  for (let index = 1; index < initiallyVisible; index++) await page.keyboard.press('ArrowRight');
  expect(await firstRail.evaluate((node) => node.scrollLeft)).toBe(0);
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
  for (let index = initiallyVisible + 1; index < 10; index++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="series-s10"]')).toBeFocused();
  await expect.poll(() => firstRail.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await expect(page.locator('[data-focus="series-s10"] .card-copy strong')).toHaveText('自然小课堂 10');
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
  await expect.poll(() => page.locator('.topbar').evaluate((node) => node.getBoundingClientRect().top)).toBeLessThan(navigationY);
  await page.screenshot({ path: 'test-results/tv-page-scroll.png' });
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
  const returnFocus = await page.locator('[data-rail="home-row-2"] .focused').getAttribute('data-focus');
  await page.keyboard.press('ContextMenu');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('[data-focus="re-pair"]')).toBeFocused();
  await expect(page.getByRole('button', { name: /连接设置/ })).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => page.locator('[role="dialog"] .focused').count()).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator(`[data-focus="${returnFocus}"]`)).toBeFocused();
  await page.screenshot({ path: 'test-results/tv-rails.png' });
  await expect(page.locator('[data-focus="children"]')).toHaveCount(0);
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
  expect(await firstRail.evaluate((node) => node.scrollLeft)).toBe(0);
});

test('card covers and resume progress with folder banner artwork', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify({
    accessToken: 'presentation-access', refreshToken: 'presentation-refresh', deviceId: 'device', childId: 'child',
  })));
  const heroRequests: string[] = [];
  await page.route('**/api/me', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/families/me/children', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/home**', (route) => route.fulfill({ json: { rows: [{ title: '继续观看', items: [
    { id: 'a', name: '第一集', type: 'episode', positionMs: 30000, runtimeMs: 120000, image: { url: '/api/items/a/image?v=first' } },
    { id: 'b', name: '第二集', type: 'episode', positionMs: 10, runtimeMs: 0, image: { url: '/api/items/b/image' } },
    { id: 'c', name: '自然课堂', episodeCount: 1, image: { url: '/api/items/c/image?v=third' } },
    { id: 'd', name: '小鼠波波 2026版', episodeCount: 1 },
  ] }] } }));
  await page.route('**/api/items/*/image?*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('w') === '960') heroRequests.push(url.pathname);
    const width = url.pathname.includes('/c/') ? 720 : 640;
    return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="360"><rect width="100%" height="100%" fill="#446655"/></svg>` });
  });
  await page.route('**/api/series/c/playlist**', (route) => route.fulfill({ json: { items: [{ id: 'ready', name: '动物', type: 'episode', runtimeMs: 60000, image: { url: '/api/items/c/image?v=third' } }], itemTotal: 1, itemsHasMore: false, episodeId: 'ready', episodes: [
    { id: 'ready', name: '动物', runtimeMs: 60000, image: { url: '/api/items/c/image?v=third' } },
  ] } }));
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-a"]')).toBeFocused();
  await expect(page.getByRole('progressbar', { name: '观看进度' })).toHaveAttribute('aria-valuenow', '25');
  await expect(page.locator('[data-focus="series-a"] .cover img')).toBeVisible();
  await expect(page.getByRole('region', { name: '选中内容预览' })).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="series-c"]')).toBeFocused();
  await expect.poll(() => page.locator('[data-focus="series-c"] .cover img').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(720);
  expect(heroRequests).toEqual([]);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="series-d"]')).toBeFocused();
  await expect(page.locator('[data-focus="series-d"] .cover img')).toHaveCount(0);
  await expect(page.locator('[data-focus="series-d"] .cover-letter')).toHaveText('小鼠');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-focus="series-c"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="episode-ready"]')).toBeFocused();
  await expect(page.getByRole('region', { name: '文件夹详情' }).getByRole('heading')).toHaveText('自然课堂');
  await expect(page.locator('.detail-count')).toHaveText('1 个视频');
  await page.screenshot({ path: '/tmp/molly-tv-restored-banner.png' });
  await expect.poll(() => page.locator('.detail-art img').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(720);
  expect(heroRequests).toEqual(['/api/items/c/image']);
  await expect(page.locator('[data-focus="season-empty"]')).toHaveCount(0);
  await expect(page.getByText('0 集', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-focus="episode-ready"] .cover img')).toBeVisible();
});


test('folder videos form a vertical grid with remote row navigation', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify({
    accessToken: 'test', refreshToken: 'test', deviceId: 'test', childId: '',
  })));
  await page.route('**/api/me', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/families/me/children', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/home**', (route) => route.fulfill({ json: { rows: [{ title: '媒体库', items: [{ id: 'grid', name: '故事集', episodeCount: 26 }] }] } }));
  await page.route('**/api/series/grid/playlist**', (route) => route.fulfill({ json: {
    items: Array.from({ length: 26 }, (_, index) => ({ id: `grid-${index}`, name: `第 ${index + 1} 集`, type: 'episode', runtimeMs: 300000 })), itemTotal: 26, itemsHasMore: false,
    episodes: Array.from({ length: 26 }, (_, index) => ({ id: `grid-${index}`, name: `第 ${index + 1} 集`, runtimeMs: 300000 })),
  } }));
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-grid"]')).toBeFocused();
  await page.keyboard.press('Enter');
  const cards = page.locator('.episode-grid .poster');
  await expect(cards).toHaveCount(26);
  await expect(cards.first()).toBeFocused();
  const columns = await cards.evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).offsetTop === (nodes[0] as HTMLElement).offsetTop).length);
  expect(columns).toBeGreaterThan(1);
  expect(columns).toBeLessThan(26);
  await page.keyboard.press('ArrowDown');
  await expect(cards.nth(columns)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(cards.first()).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(cards.first()).toBeFocused();
  for (let row = 1; row <= Math.floor(25 / columns); row++) {
    await page.keyboard.press('ArrowDown');
    await expect(cards.nth(row * columns)).toBeFocused();
  }
  await expect.poll(() => page.locator('.shelves-scroll').evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(cards.nth(Math.floor(25 / columns) * columns)).toBeInViewport();
  expect(await page.locator('.episode-grid').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/tv-video-grid.png' });
});

test('native container focus restores a control without row or page outlines', async ({ page }) => {
  await page.goto('/tv/?mock=1');
  const first = page.locator('[data-focus="series-demo-series-1-episode-1"]');
  const second = page.locator('[data-focus="series-demo-series-1-episode-2"]');
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(second).toBeFocused();
  for (const selector of ['[data-rail="home-row-0"]', '[data-focus-region="content"]', '[data-focus-region="screen"]']) {
    const container = page.locator(selector);
    // tabindex also covers older WebViews that don't implicitly focus scrollers.
    await container.evaluate((node: HTMLElement) => { node.tabIndex = -1; node.focus({ preventScroll: true }); });
    await expect(second).toBeFocused();
    await expect(container).toHaveCSS('outline-style', 'none');
    await expect(page.locator('.poster.focused')).toHaveCount(1);
  }
  await expect(second.locator('.cover')).not.toHaveCSS('box-shadow', 'none');
  // A disabled/stale selection must fall back to a usable control in that row.
  await second.evaluate((node: HTMLButtonElement) => { node.disabled = true; });
  await page.locator('[data-rail="home-row-0"]').evaluate((node: HTMLElement) => node.focus());
  await expect(first).toBeFocused();
  await page.keyboard.press('ContextMenu');
  const dialogControl = page.locator('[role="dialog"] [data-focused="true"]');
  await expect(dialogControl).toBeFocused();
  await page.locator('[data-focus-region="content"]').evaluate((node: HTMLElement) => node.focus());
  await expect(dialogControl).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.locator('[data-rail="home-row-1"] .focused').count()).toBe(1);
});

test('rail scrolling keeps arrow geometry out of animation frames', async ({ page }) => {
  await page.goto('/tv/?mock=1');
  const rail = page.locator('[data-rail="home-row-0"]');
  const shelf = page.locator('.shelf').first();
  await expect(page.locator('[data-focus="series-demo-series-1-episode-1"]')).toBeFocused();
  await expect(rail.locator('.cover img').first()).toBeVisible();
  // Wait for initial arrow measurements before counting layout reads during motion.
  await expect.poll(() => shelf.evaluate((node) => parseFloat((node.querySelector('.rail-shell') as HTMLElement).style.getPropertyValue('--rail-arrow-top')))).toBeGreaterThan(0);
  // Settle the first-visit entrance before measuring horizontal scrolling.
  await page.keyboard.press('ArrowUp');
  const bounds = await rail.boundingBox();
  await rail.evaluate((node) => {
    const cover = node.querySelector<HTMLElement>('.cover')!;
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!.get!;
    const w = window as unknown as { arrowLayoutReads: number };
    w.arrowLayoutReads = 0;
    Object.defineProperty(cover, 'offsetHeight', { configurable: true, get() { w.arrowLayoutReads++; return height.call(this); } });
  });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="series-demo-series-1-episode-2"]')).toBeFocused();
  expect(await rail.evaluate((node) => node.scrollLeft)).toBe(0);
  const initiallyVisible = await rail.evaluate((node) => Array.from(node.querySelectorAll<HTMLElement>('button[data-focus]'))
    .filter((card) => card.offsetLeft + card.offsetWidth * 1.055 <= node.clientWidth - 20).length);
  const totalCards = await rail.locator('button[data-focus]').count();
  for (let index = 2; index < initiallyVisible; index++) await page.keyboard.press('ArrowRight');
  expect(await rail.evaluate((node) => node.scrollLeft)).toBe(0);
  await page.keyboard.press('ArrowRight');
  await expect(shelf.locator('.rail-direction-left')).toHaveClass(/available/);
  await expect.poll(() => rail.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { arrowLayoutReads: number }).arrowLayoutReads)).toBe(0);
  expect(await rail.boundingBox()).toEqual(bounds);
  for (let index = initiallyVisible + 1; index < totalCards; index++) await page.keyboard.press('ArrowRight');
  await expect(rail.locator('button[data-focus]').last()).toBeFocused();
  await expect(shelf.locator('.rail-direction-right')).not.toHaveClass(/available/);
  await page.keyboard.press('ArrowLeft');
  await expect(rail.locator('button[data-focus]').nth(totalCards - 2)).toBeFocused();
  const rightEnd = await rail.evaluate((node) => node.scrollLeft);
  const firstVisibleAtEnd = await rail.evaluate((node) => Array.from(node.querySelectorAll<HTMLElement>('button[data-focus]'))
    .findIndex((card) => card.offsetLeft >= node.scrollLeft + 20));
  for (let index = totalCards - 3; index >= firstVisibleAtEnd; index--) await page.keyboard.press('ArrowLeft');
  expect(await rail.evaluate((node) => node.scrollLeft)).toBe(rightEnd);
  for (let index = firstVisibleAtEnd - 1; index >= 0; index--) await page.keyboard.press('ArrowLeft');
  await expect.poll(() => rail.evaluate((node) => node.scrollLeft)).toBe(0);
  await page.locator('[data-focus="series-demo-series-1-episode-1"]').focus();
  await expect(shelf.locator('.rail-direction-left')).not.toHaveClass(/available/);
  expect(await rail.boundingBox()).toEqual(bounds);
  await page.setViewportSize({ width: 960, height: 540 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { arrowLayoutReads: number }).arrowLayoutReads)).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/tv-scroll-directions.png' });
});

test('mock preview browses 80 episodes without backend or binding changes', async ({ page }) => {
  const apiRequests: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()); });
  await page.addInitScript(() => localStorage.setItem('mollytime.tv.binding.v1', 'existing-binding'));
  await page.goto('/tv/?mock=1');
  await expect(page.locator('[data-focus="series-demo-series-1-episode-1"]')).toBeFocused();
  await expect(page.locator('.shelf-heading h2')).toHaveText(['最近播放', '发现新故事', '我的媒体库']);
  const recentRail = page.locator('.shelf').first();
  const arrowCenterError = () => recentRail.evaluate((node) => {
    const cover = node.querySelector('.poster:not(.focused) .cover')!.getBoundingClientRect();
    return Math.max(...Array.from(node.querySelectorAll('.rail-direction')).map((arrow) => {
      const bounds = arrow.getBoundingClientRect();
      return Math.abs(bounds.top + bounds.height / 2 - cover.top - cover.height / 2);
    }));
  });
  await expect.poll(arrowCenterError).toBeLessThan(1);
  await page.screenshot({ path: 'test-results/tv-home-directions.png' });
  await expect(recentRail.locator('.rail-direction-right')).toHaveClass(/available/);
  await expect(recentRail.locator('.rail-direction-left')).not.toHaveClass(/available/);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="series-demo-series-1-episode-2"]')).toBeFocused();
  await expect(recentRail.locator('.rail-direction-left')).not.toHaveClass(/available/);
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await expect(recentRail.locator('.rail-direction-left')).toHaveClass(/available/);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.locator('[data-rail="home-row-1"] .focused').count()).toBe(1);
  await expect(page.locator('[data-grid="home-row-2"] .poster')).toHaveCount(24);
  await expect(page.locator('.library-shelf .rail-track')).toHaveCount(0);
  await page.locator('[data-focus="home-2-demo-series-1"]').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-focus="home-2-demo-series-5"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-focus="home-2-demo-series-1"]')).toBeFocused();
  await page.keyboard.press('Enter');
  const cards = page.locator('.episode-grid .poster');
  await expect(cards).toHaveCount(24);
  await expect(page.locator('[data-focus="episode-demo-series-1-episode-1"]')).toBeFocused();
  await expect(cards.first().locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml/);
  const columns = await cards.evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).offsetTop === (nodes[0] as HTMLElement).offsetTop).length);
  let index = 0;
  while ((Math.floor(index / columns) + 1) * columns < 80) {
    index = Math.min(index + columns, 79);
    await page.keyboard.press('ArrowDown');
    await expect(cards.nth(index)).toBeFocused();
  }
  await expect(cards.nth(index)).toBeInViewport();
  await expect.poll(() => cards.nth(index).evaluate((node) => node.getBoundingClientRect().bottom - node.closest('.shelves-scroll')!.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0);
  await expect(cards).toHaveCount(80);
  await page.screenshot({ path: 'test-results/tv-mock-grid.png' });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('没有实际视频');
  await page.keyboard.press('Escape');
  await expect(cards.nth(index)).toBeFocused();
  expect(apiRequests).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('mollytime.tv.binding.v1'))).toBe('existing-binding');
});

for (const outcome of ['cancel', 'error'] as const) {
  test(`update has one action and keeps the downloaded package after install ${outcome}`, async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as {
        updateCalls: string[];
        MollyBridge: { postMessage: (raw: string) => void; onmessage?: (event: { data: string }) => void };
      };
      w.updateCalls = [];
      w.MollyBridge = { postMessage(raw) {
        const { id, method, args } = JSON.parse(raw);
        let result: unknown = { ok: true };
        if (method === 'getCapabilities') result = { bridgeVersion: 1, serverUrl: 'https://media.example.test', authenticated: true, clientUpdates: true, shellVersion: '0.4.0' };
        if (method === 'request' && args.path.split('?')[0] === '/api/home') result = { rows: [{ title: '媒体库', items: [{ id: 'story', name: '故事', episodeCount: 1 }] }] };
        if (method === 'request' && args.path === '/api/families/me/children') result = [];
        if (['checkUpdate', 'downloadUpdate', 'installUpdate'].includes(method)) w.updateCalls.push(method);
        if (method === 'checkUpdate') result = { release: { versionName: '0.5.0', size: 2097152, notes: '更新说明' } };
        setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
      } };
    });
    const emit = (detail: object) => page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent('molly:clientUpdateProgress', { detail }));
    }, detail);
    const calls = () => page.evaluate(() => (window as unknown as { updateCalls: string[] }).updateCalls);
    const open = async () => {
      await page.keyboard.press('ContextMenu');
      await page.locator('[data-focus="check-update"]').click();
    };
    await page.goto('/tv/');
    await expect(page.locator('[data-focus="series-story"]')).toBeFocused();
    await open();
    const action = page.locator('[data-focus="client-update-action"]');
    await expect(action).toHaveText('立即更新');
    await expect(page.locator('[data-focus="check-update"]')).toBeFocused();
    await action.click();
    await expect(action).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重新检查' })).toHaveCount(0);
    await emit({ state: 'downloading', received: 100, total: 100 });
    await expect(page.getByRole('status')).toHaveText('正在准备安装…');
    await page.getByRole('button', { name: '返回媒体库' }).click();
    await open();
    await expect(page.getByRole('status')).toHaveText('正在准备安装…');
    await emit({ state: 'downloaded' });
    await expect(action).toHaveText('立即安装');
    await expect(page.locator('[data-focus="check-update"]')).toBeFocused();
    await page.getByRole('button', { name: '返回媒体库' }).click();
    await open();
    await expect(action).toHaveText('立即安装');
    await expect(page.locator('[data-focus="check-update"]')).toBeFocused();
    await action.click();
    await expect(action).toHaveCount(0);
    await emit(outcome === 'cancel'
      ? { state: '尚未安装，更新包已保留', phase: 'ready' }
      : { state: '安装失败，请重试', phase: 'error' });
    await expect(action).toHaveText(outcome === 'cancel' ? '立即安装' : '重试');
    await expect(page.locator('[data-focus="check-update"]')).toBeFocused();
    await action.click();
    await expect.poll(calls).toEqual(['checkUpdate', 'downloadUpdate', 'installUpdate', 'installUpdate']);
  });
}
