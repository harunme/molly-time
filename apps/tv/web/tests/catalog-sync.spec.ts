import { test, expect, type Page } from '@playwright/test';

async function localCatalog(page: Page, rail = false) {
  await page.addInitScript((rail) => {
    const w = window as any;
    w.calls = []; w.localCount = 960;
    w.MollyBridge = { postMessage(raw: string) {
      const { id, method, args } = JSON.parse(raw); w.calls.push({ method, args });
      let result: unknown = { ok: true };
      if (method === 'getCapabilities') result = { bridgeVersion: 1, authenticated: true, nativePlayback: true, catalogSync: true, offlinePlayback: true };
      if (method === 'catalogStatus') result = { supported: true, online: false, lastSync: 1780000000000, catalogComplete: true };
      if (method === 'catalogRead') result = { data: args.kind === 'home' ? { rows: [...(w.addRecent ? [{ id: 'recently-played', title: '最近播放', items: [{ id: 'recent', name: '最近播放的视频', type: 'episode' }], hasMore: false }] : []), { id: rail ? 'curated' : 'library', title: rail ? '推荐' : '我的媒体库', hasMore: false,
        items: Array.from({ length: w.localCount }, (_, i) => ({ id: `folder-${i}`, name: `故事 ${i}` })) }] } : { total: 960, hasMore: false, hasProgress: true, episodeId: 'e-800', resumeEpisode: { id: 'e-800', name: '视频 800' },
          episodes: Array.from({ length: 960 }, (_, i) => ({ id: `e-${i}`, name: `视频 ${i}`, runtimeMs: 60000 })) } };
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 1);
    } };
  }, rail);
  await page.goto('/tv/');
  await expect(page.locator(`[data-focus="home-${rail ? 'curated' : 'library'}-folder-0"]`)).toBeFocused();
}

test('offline native catalog renders a bounded grid, navigates logical rows and returns from deep resume', async ({ page }) => {
  await localCatalog(page);
  await expect(page.locator('.sync-status')).toContainText('离线');
  expect(await page.locator('.poster').count()).toBeLessThan(80);
  for (let i = 0; i < 28; i++) await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-focused="true"].poster')).toHaveAttribute('data-focus', /home-library-folder-[1-9][0-9]+/);
  expect(await page.locator('.poster').count()).toBeLessThan(80);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="episode-e-800"]')).toBeFocused();
  await expect(page.locator('[data-focus="episode-e-800"]')).toBeInViewport();
  await page.screenshot({ path: '/tmp/molly-tv-offline-catalog.png' });
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-focused="true"].poster')).toHaveAttribute('data-focus', /episode-e-80[1-9]/);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focused="true"].poster')).toHaveAttribute('data-focus', /home-library-folder-[1-9][0-9]+/);
  const requests = await page.evaluate(() => (window as any).calls.filter((c: any) => c.method === 'request'));
  expect(requests).toEqual([]);
});

test('long horizontal shelves mount only visible neighbors and navigate beyond the window', async ({ page }) => {
  await localCatalog(page, true);
  expect(await page.locator('.poster').count()).toBeLessThan(24);
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="home-curated-folder-30"]')).toBeFocused();
  await expect(page.locator('[data-focus="home-curated-folder-30"]')).toBeInViewport();
  expect(await page.locator('.poster').count()).toBeLessThan(24);
});

test('background catalog growth preserves focused DOM when crossing the old virtualization threshold', async ({ page }) => {
  await localCatalog(page);
  await page.evaluate(() => { (window as any).localCount = 48; window.dispatchEvent(new CustomEvent('molly:catalogChanged', { detail: { collection: 'home' } })); });
  await expect(page.locator('.virtual-grid')).toHaveAttribute('data-total-items', '48');
  await page.keyboard.press('ArrowRight');
  const focused = page.locator('[data-focus="home-library-folder-1"]');
  await expect(focused).toBeFocused();
  const original = await focused.elementHandle();
  await page.evaluate(() => { (window as any).localCount = 120; window.dispatchEvent(new CustomEvent('molly:catalogChanged', { detail: { collection: 'home' } })); });
  await expect(page.locator('.virtual-grid')).toHaveAttribute('data-total-items', '120');
  expect(await focused.evaluate((node, old) => node === old, original)).toBe(true);
  await expect(focused).toBeFocused();
});

test('adding recent playback preserves the library card and its focus', async ({ page }) => {
  await localCatalog(page);
  await page.keyboard.press('ArrowRight');
  const card = page.locator('[data-focus="home-library-folder-1"]');
  await expect(card).toBeFocused(); const original = await card.elementHandle();
  await page.evaluate(() => { (window as any).addRecent = true; window.dispatchEvent(new CustomEvent('molly:catalogChanged', { detail: { collection: 'progress' } })); });
  await expect(page.getByRole('heading', { name: '最近播放', exact: true })).toBeVisible();
  expect(await card.evaluate((node, old) => node === old, original)).toBe(true);
  await expect(card).toBeFocused(); await expect(card).toBeInViewport();
});
