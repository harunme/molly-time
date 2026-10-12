import { test, expect } from '@playwright/test';

async function openBrowserVideo(page: import('@playwright/test').Page) {
  const auth = await (await page.request.post('http://127.0.0.1:8098/api/auth/login', {
    headers: { 'X-Molly-Client': 'tv-shell/2' }, data: { username: 'parent', password: 'parent-e2e' },
  })).json();
  await page.addInitScript((binding) => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify(binding)), {
    accessToken: auth.accessToken, refreshToken: auth.refreshToken, deviceId: auth.deviceId, childId: 'autoplay-child',
  });
  await page.goto('http://127.0.0.1:8098/tv/');
  await page.locator('[data-focus="series-series"]').click();
  await page.locator('[data-focus="episode-browser-episode"]').click();
  await expect(page.getByRole('dialog', { name: '视频播放' })).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate((video) => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  return auth;
}

test('normal ending starts the next folder video, reports separate sessions, and stops at the last', async ({ page }) => {
  const events: { episode: string; completed: boolean; stopped: boolean }[] = [];
  const sessionEpisodes = new Map<string, string>();
  page.on('response', async (response) => {
    if (response.request().method() === 'POST' && response.url().endsWith('/api/playback/sessions')) {
      const session = await response.json();
      sessionEpisodes.set(session.sessionId, response.request().postDataJSON().episodeId);
    }
  });
  page.on('request', (request) => {
    const match = request.url().match(/\/api\/playback\/sessions\/([^/]+)\/events$/);
    if (match) {
      const data = request.postDataJSON();
      events.push({ episode: sessionEpisodes.get(match[1]) || '', completed: data.completed, stopped: data.stopped });
    }
  });
  await page.route('**/api/episodes/browser-next/progress?*', (route) => route.fulfill({ json: { positionMs: 4000, completed: false } }));
  await openBrowserVideo(page);
  const next = page.waitForResponse((response) => response.url().includes('/api/episodes/browser-next/playback') && response.ok());
  await page.locator('video').evaluate((video) => { (video as HTMLVideoElement).currentTime = (video as HTMLVideoElement).duration - 0.15; });
  await next;
  await expect(page.locator('video')).toHaveAttribute('src', /mediaId=browser-next-media/);
  await expect.poll(() => page.locator('video').evaluate((video) => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  expect(await page.locator('video').evaluate((video) => (video as HTMLVideoElement).currentTime)).toBeLessThan(2);
  await expect.poll(() => events.some((event) => event.episode === 'browser-episode' && event.completed && event.stopped)).toBe(true);
  await page.locator('video').evaluate((video) => { (video as HTMLVideoElement).currentTime = (video as HTMLVideoElement).duration - 0.15; });
  await expect(page.getByRole('dialog', { name: '视频播放' })).toHaveCount(0);
  await expect.poll(() => events.some((event) => event.episode === 'browser-next' && event.completed && event.stopped)).toBe(true);
});

test('return cancels a pending next lookup and a late response cannot reopen playback', async ({ page }) => {
  let release: (() => void) | undefined;
  let requested = false;
  await page.route('**/api/episodes/browser-episode/next', async (route) => {
    requested = true;
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { episodeId: 'browser-next' } });
  });
  let nextOpened = false;
  page.on('request', (request) => { if (request.url().includes('/api/episodes/browser-next/playback')) nextOpened = true; });
  const lookup = page.waitForResponse((response) => response.url().endsWith('/api/episodes/browser-episode/next'));
  await openBrowserVideo(page);
  await page.locator('video').evaluate((video) => { (video as HTMLVideoElement).currentTime = (video as HTMLVideoElement).duration - 0.15; });
  await expect.poll(() => requested).toBe(true);
  await page.getByRole('button', { name: '返回视频列表' }).click();
  release!();
  await lookup;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('dialog', { name: '视频播放' })).toHaveCount(0);
  await expect(page.locator('[data-focus="episode-browser-episode"]')).toBeVisible();
  expect(nextOpened).toBe(false);
});


test('a failed next lookup stays stopped and supports an explicit retry', async ({ page }) => {
  let lookups = 0;
  await page.route('**/api/episodes/browser-episode/next', async (route) => {
    lookups++;
    if (lookups === 1) await route.fulfill({ status: 503, json: { detail: 'Temporary failure' } });
    else await route.fulfill({ json: { episodeId: 'browser-next' } });
  });
  await openBrowserVideo(page);
  await page.locator('video').evaluate((video) => { (video as HTMLVideoElement).currentTime = (video as HTMLVideoElement).duration - 0.15; });
  await expect(page.getByRole('button', { name: '重试下一集' })).toBeFocused();
  await expect(page.getByRole('alert')).toContainText('下一集加载失败');
  expect(lookups).toBe(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('video')).toHaveAttribute('src', /mediaId=browser-next-media/);
  expect(lookups).toBe(2);
  await page.getByRole('button', { name: '返回视频列表' }).click();
});
