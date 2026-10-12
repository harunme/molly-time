import { test, expect } from '@playwright/test';

test('remote navigation, playback return, route restoration and logout', async ({ page }) => {
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
        if (path === '/api/series/s2') result = { seasons: [{ id: 'season1', name: '第一季', episodeCount: 2 }] };
        if (path === '/api/seasons/season1') result = { episodes: [
          { id: 'e1', name: '红色在哪里', runtimeMs: 120000 }, { id: 'e2', name: '蓝色的天空', runtimeMs: 180000 },
        ] };
      }
      if (method === 'playEpisode') w.playbackId = args.episodeId;
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
    } };
  });
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-s1"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="series-s2"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="season-season1"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="episode-e1"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="episode-e2"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { playbackId: string }).playbackId)).toBe('e2');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:playbackClosed')));
  await expect(page.locator('[data-focus="episode-e2"]')).toBeFocused();
  await page.screenshot({ path: 'test-results/tv-episodes.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="season-season1"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="series-s2"]')).toBeFocused();
  await page.getByRole('button', { name: '选择儿童' }).click();
  await page.getByRole('button', { name: '小朋友' }).click();
  await page.getByRole('button', { name: '退出账号' }).click();
  await expect(page.getByRole('heading', { name: '进入家庭媒体库' })).toBeVisible();
});

test('browser login reports rejected credentials and recovers', async ({ page }) => {
  await page.route('**/api/auth/login', (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({ status: body.password === 'correct' ? 200 : 401, json: body.password === 'correct' ?
      { accessToken: 'test', refreshToken: 'refresh', user: { name: '家长' } } : { detail: 'Unauthorized' } });
  });
  await page.route('**/api/home', (route) => route.fulfill({ json: { rows: [] } }));
  await page.route('**/api/families/me/children', (route) => route.fulfill({ json: [] }));
  await page.goto('/tv/');
  await page.getByLabel('账号').fill('parent');
  await page.getByLabel('密码').fill('wrong');
  await page.getByRole('button', { name: '进入媒体库' }).click();
  await expect(page.getByRole('alert')).toContainText('请检查账号密码');
  await page.getByLabel('密码').fill('correct');
  await page.getByRole('button', { name: '进入媒体库' }).click();
  await expect(page.getByText('媒体库还没有内容')).toBeVisible();
});
