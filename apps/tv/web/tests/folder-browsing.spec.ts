import { expect, test } from '@playwright/test';

for (const local of [false, true]) test(`nested folders preserve manual order, remote focus and return path (${local ? 'offline catalog' : 'API'})`, async ({ page }) => {
  await page.addInitScript(local => {
    const w = window as any;
    w.played = [];
    const folder = (id: string, name: string) => ({ id, name, type: 'folder', episodeCount: 2 });
    const video = (id: string) => ({ id, name: id, type: 'episode', seasonName: 'Songs', runtimeMs: 60000 });
    const children: Record<string, any[]> = {
      'root-z': [folder('songs', '韵律儿歌'), video('root-video')],
      songs: [folder('season', '动作儿歌')],
      season: [video('video-b'), video('video-a')],
    };
    const home = { rows: [{ id: 'library', title: '我的媒体库', items: [folder('root-z', 'Super Simple Songs'), folder('root-a', '其他故事')], total: 2, hasMore: false }] };
    w.MollyBridge = { postMessage(raw: string) {
      const { id, method, args } = JSON.parse(raw);
      let result: any = { ok: true };
      if (method === 'getCapabilities') result = { bridgeVersion: 1, authenticated: true, nativePlayback: true, serverUrl: 'https://media.test', catalogSync: local };
      if (method === 'catalogStatus') result = { online: false, catalogComplete: true };
      if (method === 'playEpisode') w.played.push(args.episodeId);
      if (method === 'request' || method === 'catalogRead') {
        const url = new URL(args.path || '/api/home', location.origin);
        const folderId = args.kind === 'playlist' ? args.folderId : url.pathname.match(/\/series\/([^/]+)\/playlist/)?.[1];
        if (!folderId) result = home;
        else {
          const items = children[folderId] || [];
          result = { items, itemTotal: items.length, itemsHasMore: false, episodes: [video('video-b'), video('video-a'), video('root-video')], total: 3, hasMore: false, page: 1, episodeId: 'video-b', hasProgress: false };
        }
        if (method === 'catalogRead') result = { data: result };
      }
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
    } };
  }, local);
  await page.goto('/tv/');
  const homeFocus = local ? 'home-library-root-z' : 'series-root-z';
  await expect(page.locator(`[data-focus="${homeFocus}"]`)).toBeFocused();
  await expect(page.locator('.library-shelf .card-copy strong')).toHaveText(['Super Simple Songs', '其他故事']);
  await page.keyboard.press('Enter');
  await expect(page.locator('.episode-grid .card-copy strong')).toHaveText(['韵律儿歌', 'root-video']);
  await expect(page.locator('[data-focus="folder-songs"]')).toBeFocused();
  expect((await page.locator('.detail-header').boundingBox())!.height).toBeLessThan(300);
  const brand = (await page.locator('.topbar').boundingBox())!;
  const path = (await page.getByLabel('文件夹路径').boundingBox())!;
  expect(path.y).toBeGreaterThanOrEqual(brand.y + brand.height);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="folder-season"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.episode-grid .card-copy strong')).toHaveText(['video-b', 'video-a']);
  await expect(page.locator('[data-focus="episode-video-b"]')).toBeFocused();
  await expect(page.getByLabel('文件夹路径')).toContainText('Super Simple Songs / 韵律儿歌');
  await page.screenshot({ path: `/tmp/molly-tv-folder-${local ? 'offline' : 'api'}.png` });
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).played)).toEqual(['video-b']);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:playbackClosed')));
  await expect(page.locator('[data-focus="episode-video-b"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-focus="folder-back"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="folder-season"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="folder-songs"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator(`[data-focus="${homeFocus}"]`)).toBeFocused();
});

test('mixed folder pages append in order and stop at the browsing total', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.pages = [];
    w.MollyBridge = { postMessage(raw: string) {
      const { id, method, args } = JSON.parse(raw);
      let result: any = { ok: true };
      if (method === 'getCapabilities') result = { bridgeVersion: 1, authenticated: true, nativePlayback: true, serverUrl: 'https://media.test' };
      if (method === 'request') {
        const url = new URL(args.path, location.origin);
        if (url.pathname === '/api/home') result = { rows: [{ id: 'library', title: '我的媒体库', items: [{ id: 'root', name: '收藏' }] }] };
        else if (url.pathname.endsWith('/root/playlist')) {
          const page = Number(url.searchParams.get('page'));
          w.pages.push(page);
          const all = Array.from({ length: 26 }, (_, i) => ({ id: `item-${i}`, name: `目录项 ${i}`, type: i % 2 ? 'episode' : 'folder' }));
          result = { items: all.slice((page - 1) * 24, page * 24), itemTotal: 26, itemsHasMore: page === 1,
            episodes: [], total: 100, hasMore: true, page, hasProgress: false, episodeId: null };
        } else if (url.pathname.endsWith('/playlist')) result = { items: [], itemTotal: 0, episodes: [], total: 0, hasMore: false, itemsHasMore: false, episodeId: null, hasProgress: false };
      }
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
    } };
  });
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-root"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.episode-grid .poster')).toHaveCount(24);
  await page.locator('[data-focus="episode-item-19"]').focus();
  await expect(page.locator('.episode-grid .poster')).toHaveCount(26);
  await expect(page.locator('[data-focus="episode-item-19"]')).toBeFocused();
  await expect(page.locator('.episode-grid .card-copy strong')).toHaveText(Array.from({ length: 26 }, (_, i) => `目录项 ${i}`));
  await page.locator('[data-focus="folder-item-24"]').focus();
  await expect(page.locator('[data-focus="folder-item-24"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '目录项 24', exact: true })).toBeVisible();
  await expect(page.locator('[data-focus="folder-back"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="folder-item-24"]')).toBeFocused();
  await expect(page.locator('.episode-grid .poster')).toHaveCount(26);
  expect(await page.evaluate(() => (window as any).pages)).toEqual([1, 2]);
});
