import { test, expect } from '@playwright/test';

for (const virtual of [false, true]) {
  test(`grid restores hero on first row and keeps column (virtual=${virtual})`, async ({ page }) => {
    await page.route('**/api/me', (route) => route.fulfill({ json: {} }));
    await page.addInitScript((virtual) => {
      const w = window as any;
      const home = { rows: [{ id: 'library', title: '我的媒体库', items: [{ id: 'songs', name: '韵律儿歌', episodeCount: 180 }] }] };
      const playlist = { total: 180, hasMore: false, episodes: Array.from({ length: 180 }, (_, i) => ({ id: `e-${i}`, name: `歌曲 ${i}`, runtimeMs: 180000 })) };
      const data = { ...playlist, items: playlist.episodes.map(episode => ({ ...episode, type: 'episode' })), itemTotal: 180, itemsHasMore: false };
      w.MollyBridge = { postMessage(raw: string) {
        const { id, method, args } = JSON.parse(raw);
        let result: unknown = { ok: true };
        if (method === 'getCapabilities') result = { bridgeVersion: 1, serverUrl: 'https://media.example.test', authenticated: true, nativePlayback: true, catalogSync: virtual };
        if (method === 'catalogStatus') result = { supported: true, online: false, catalogComplete: true };
        if (method === 'catalogRead') result = { data: args.kind === 'home' ? home : data };
        if (method === 'request') {
          const path = args.path.split('?')[0];
          if (path === '/api/home') result = home;
          if (path === '/api/series/songs/playlist') result = data;
          if (path === '/api/families/me/children') result = [];
        }
        setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 1);
      } };
    }, virtual);
    await page.goto('/tv/');
    await expect(page.locator('.poster.focused')).toContainText('韵律儿歌');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-focus="episode-e-0"]')).toBeFocused();
    const viewport = page.locator('.shelves-scroll');
    const scrollTop = () => viewport.evaluate((node) => node.scrollTop);
    const columns = await page.locator('.episode-grid').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const first = page.locator('[data-focus="episode-e-2"]');
    await expect(first).toBeFocused();
    for (const depth of [3, 12]) {
      for (let row = 1; row <= depth; row++) {
        await page.keyboard.press('ArrowDown');
        await expect(page.locator(`[data-focus="episode-e-${row * columns + 2}"]`)).toBeFocused();
      }
      await expect.poll(scrollTop).toBeGreaterThan(100);
      for (let row = depth - 1; row >= 0; row--) {
        await page.keyboard.press('ArrowUp');
        await expect(page.locator(`[data-focus="episode-e-${row * columns + 2}"]`)).toBeFocused();
        if (row > 0) await expect.poll(scrollTop).toBeGreaterThan(0);
      }
      await expect(first).toBeFocused();
      await expect.poll(scrollTop).toBe(0);
      for (let press = 0; press < 5; press++) await page.keyboard.press('ArrowUp');
      await expect(page.locator('[data-focus="folder-back"]')).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(first).toBeFocused();
      await expect.poll(scrollTop).toBe(0);
    }
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-focus="episode-e-3"]')).toBeFocused();
    await expect.poll(scrollTop).toBe(0);
  });
}
