import { test, expect, type Page } from '@playwright/test';

async function catalog(page: Page, options: { fail?: boolean; delay?: number; oldShell?: boolean } = {}) {
  await page.addInitScript((options) => {
    const w = window as unknown as {
      requests: string[]; replies: string[]; played: string; pageAttempts: number;
      MollyBridge: { postMessage: (raw: string) => void; onmessage?: (event: { data: string }) => void };
    };
    w.requests = []; w.replies = []; w.pageAttempts = 0;
    w.MollyBridge = { postMessage(raw) {
      const { id, method, args } = JSON.parse(raw);
      let result: unknown = { ok: true }, error: unknown;
      let delay = 5;
      if (method === 'getCapabilities') result = { bridgeVersion: 1, authenticated: true, childId: '', nativePlayback: true };
      if (method === 'playEpisode') w.played = args.episodeId;
      if (method === 'request') {
        w.requests.push(args.path);
        const url = new URL(args.path, location.origin);
        const page = Number(url.searchParams.get('page') ?? 1);
        const pageSize = Number(url.searchParams.get('pageSize') ?? 24);
        const paged = url.searchParams.has('page');
        const folders = Array.from({ length: 60 }, (_, index) => ({ id: `folder-${index}`, name: `故事 ${index}`, episodeCount: 60 }));
        const episodes = Array.from({ length: 60 }, (_, index) => ({ id: `video-${index}`, name: `视频 ${index}`, seasonName: '故事', runtimeMs: 60000 }));
        const batch = <T,>(items: T[]) => paged ? items.slice((page - 1) * pageSize, page * pageSize) : items;
        const info = paged ? { page, pageSize, total: 60, hasMore: page * pageSize < 60 } : {};
        if (url.pathname === '/api/home') result = { rows: [{ id: 'library', title: '我的媒体库', items: batch(folders), ...info }] };
        if (url.pathname.endsWith('/playlist')) result = { episodes: batch(episodes), episodeId: 'video-50', hasProgress: true, resumeEpisode: episodes[50], ...info };
        if (url.pathname === '/api/families/me/children') result = [];
        if (page > 1) {
          delay = options.delay ?? 80;
          w.pageAttempts++;
          if (options.fail && w.pageAttempts === 1) error = { message: '加载失败，请重试', status: 503 };
        }
        if (options.oldShell && paged) error = { message: '接口不允许访问' };
      }
      setTimeout(() => { w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result, error }) }); if (args?.path) w.replies.push(args.path); }, delay);
    } };
  }, options);
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-folder-0"]')).toBeFocused();
}

test('catalog batches start at the first video and preserve focus and return position', async ({ page }) => {
  await catalog(page);
  const cards = page.locator('.library-shelf .poster');
  await expect(cards).toHaveCount(24);
  await page.locator('[data-focus="series-folder-18"]').focus();
  await expect(cards).toHaveCount(48);
  await expect(page.locator('[data-focus="series-folder-18"]')).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { requests: string[] }).requests.filter((path) => path.includes('page=2')))).toHaveLength(1);
  await page.locator('[data-focus="series-folder-30"]').focus();
  const scroll = await page.locator('.shelves-scroll').evaluate((node) => node.scrollTop);
  await page.keyboard.press('Enter');
  await expect(page.locator('.detail-count')).toHaveText('60 个视频');
  await expect(page.locator('.episode-grid .poster')).toHaveCount(24);
  await expect(page.locator('.episode-grid .poster').first()).toHaveAttribute('data-focus', 'episode-video-0');
  await expect(page.locator('[data-focus="episode-video-50"]')).toHaveCount(0);
  await expect(page.locator('[data-focus="episode-video-0"]')).toBeFocused();
  await page.locator('[data-focus="episode-video-18"]').focus();
  await expect(page.locator('.episode-grid .poster')).toHaveCount(48);
  await expect(page.locator('[data-focus="episode-video-18"]')).toBeFocused();
  await page.locator('[data-focus="episode-video-44"]').focus();
  await expect(page.locator('.episode-grid .poster')).toHaveCount(60);
  await expect(page.locator('[data-focus="episode-video-44"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { played: string }).played)).toBe('video-44');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:playbackClosed')));
  await expect(page.locator('[data-focus="episode-video-44"]')).toBeFocused();
  await expect(page.locator('.episode-grid .poster')).toHaveCount(60);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="series-folder-30"]')).toBeFocused();
  await expect(cards).toHaveCount(48);
  expect(await page.locator('.shelves-scroll').evaluate((node) => node.scrollTop)).toBeGreaterThanOrEqual(scroll);
});

test('failed next batch leaves cards usable and supports explicit retry', async ({ page }) => {
  await catalog(page, { fail: true });
  await page.locator('[data-focus="series-folder-18"]').focus();
  await expect(page.getByRole('alert')).toHaveText('加载失败，请重试');
  await expect(page.locator('.poster')).toHaveCount(24);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-focus="series-folder-17"]')).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { pageAttempts: number }).pageAttempts)).toBe(1);
  await page.getByRole('button', { name: '重试加载' }).click();
  await expect(page.locator('.poster')).toHaveCount(48);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a late batch from a closed folder does not replace the home view', async ({ page }) => {
  await catalog(page, { delay: 500 });
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="episode-video-0"]')).toBeFocused();
  await page.locator('[data-focus="episode-video-18"]').focus();
  await expect.poll(() => page.evaluate(() => (window as unknown as { pageAttempts: number }).pageAttempts)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="series-folder-0"]')).toBeFocused();
  // Wait for the delayed reply, then confirm it was discarded.
  await expect.poll(() => page.evaluate(() => (window as unknown as { replies: string[] }).replies.some((path) => path.includes('/playlist?page=2')))).toBe(true);
  await expect(page.locator('.episode-shelf')).toHaveCount(0);
  await expect(page.locator('.library-shelf .poster')).toHaveCount(24);
});

test('older shell can browse through the unpaged fallback', async ({ page }) => {
  await catalog(page, { oldShell: true });
  await expect(page.locator('.poster')).toHaveCount(60);
  await expect(page.locator('[data-focus="more-library"]')).toHaveCount(0);
  const requests = await page.evaluate(() => (window as unknown as { requests: string[] }).requests);
  expect(requests).toContain('/api/home?page=1&pageSize=24');
  expect(requests).toContain('/api/home');
});
