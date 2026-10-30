import { test, expect, type Page } from '@playwright/test';

async function catalog(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      motionLog: string[];
      MollyBridge: { postMessage: (raw: string) => void; onmessage?: (event: { data: string }) => void };
    };
    w.motionLog = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (animation.id.startsWith('tv-')) w.motionLog.push(animation.id);
      return animation;
    };
    w.MollyBridge = { postMessage(raw) {
      const { id, method, args } = JSON.parse(raw);
      let result: unknown = { ok: true };
      if (method === 'getCapabilities') result = { bridgeVersion: 1, authenticated: true, nativePlayback: true, serverUrl: 'https://media.example.test', clientUpdates: true, shellVersion: '0.4.0' };
      if (method === 'checkUpdate') result = { release: { versionName: '0.5.0', size: 2097152, notes: '播放体验优化' } };
      if (method === 'request') {
        if (args.path.split('?')[0] === '/api/home') result = { rows: ['最近播放', '一起看故事', '探索世界'].map((title, row) => ({
          title, items: Array.from({ length: 6 }, (_, index) => ({ id: `f-${row}-${index}`, name: `故事 ${index + 1}`, episodeCount: 2 })),
        })) };
        if (args.path.includes('/playlist')) result = { episodes: [{ id: 'e1', name: '第一集' }], episodeId: null, hasProgress: false };
        if (args.path === '/api/families/me/children') result = [];
        if (args.path === '/api/settings/playback') result = { defaultSubtitle: 'zh' };
      }
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
    } };
  });
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-f-0-0"]')).toBeFocused();
}
const log = (page: Page) => page.evaluate(() => (window as unknown as { motionLog: string[] }).motionLog);

test('home entrance yields to the remote and does not replay after navigation or playback', async ({ page }) => {
  await catalog(page);
  const initialEntrances = (await log(page)).filter((id) => id === 'tv-home-entry').length;
  expect(initialEntrances).toBeGreaterThan(0);
  await page.locator('main').evaluate((node) => {
    node.getAnimations({ subtree: true }).filter((animation) => animation.id === 'tv-home-entry').forEach((animation) => { animation.pause(); animation.currentTime = 120; });
  });
  await page.screenshot({ path: 'test-results/tv-home-motion-entering.png', animations: 'allow' });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="series-f-0-1"]')).toBeFocused();
  expect(await page.locator('main').evaluate((node) => node.getAnimations({ subtree: true }).filter((animation) => animation.id === 'tv-home-entry').length)).toBe(0);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="episode-e1"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:playbackClosed')));
  await expect(page.locator('[data-focus="episode-e1"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="series-f-0-1"]')).toBeFocused();
  expect((await log(page)).filter((id) => id === 'tv-home-entry')).toHaveLength(initialEntrances);
  await page.screenshot({ path: 'test-results/tv-home-motion-settled.png' });
});

test('settings pages move forward and back while retaining focus and one dialog', async ({ page }) => {
  await catalog(page);
  const initialEntrances = (await log(page)).filter((id) => id === 'tv-home-entry').length;
  await page.keyboard.press('ContextMenu');
  await expect(page.locator('[data-focus="re-pair"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="cancel-re-pair"]')).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('[data-focus="re-pair"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="series-f-0-0"]')).toBeFocused();
  expect((await log(page)).filter((id) => id.startsWith('tv-panel-'))).toEqual(['tv-panel-open', 'tv-panel-forward', 'tv-panel-back']);
  expect((await log(page)).filter((id) => id === 'tv-home-entry')).toHaveLength(initialEntrances);
});

test('reduced motion keeps the home and settings usable without entrance animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await catalog(page);
  await page.keyboard.press('ContextMenu');
  await expect(page.locator('[data-focus="re-pair"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="cancel-re-pair"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="re-pair"]')).toBeFocused();
  expect(await log(page)).toEqual([]);
});
