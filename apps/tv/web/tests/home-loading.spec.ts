import { test, expect, type Page } from '@playwright/test';

async function pendingHome(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      replyHome?: (fail?: boolean) => void;
      greetingEntries: number;
      MollyBridge: { postMessage: (raw: string) => void; onmessage?: (event: { data: string }) => void };
    };
    w.greetingEntries = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      if (this.matches('.home-greeting')) w.greetingEntries++;
      return animate.apply(this, args);
    };
    w.MollyBridge = { postMessage(raw) {
      const { id, method, args } = JSON.parse(raw);
      let result: unknown = { ok: true };
      if (method === 'getCapabilities') result = { bridgeVersion: 1, authenticated: true, serverUrl: 'https://media.example.test', clientUpdates: true, shellVersion: '0.4.0' };
      if (method === 'request' && args.path.split('?')[0] === '/api/home') {
        w.replyHome = (fail = false) => w.MollyBridge.onmessage?.({ data: JSON.stringify(fail
          ? { id, error: { status: 503, message: '暂时无法连接媒体库，请重试' } }
          : { id, result: { rows: [{ title: '最近播放', items: [{ id: 'story', name: '小故事', episodeCount: 2 }] }] } }) });
        return;
      }
      if (method === 'request' && args.path === '/api/families/me/children') result = [];
      if (method === 'request' && args.path === '/api/settings/playback') result = { defaultSubtitle: 'zh' };
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify({ id, result }) }), 5);
    } };
  });
  await page.goto('/tv/');
  await expect(page.getByLabel('正在加载媒体库')).toBeVisible();
  await expect(page.locator('.home-greeting')).toBeVisible();
}
const reply = (page: Page, fail = false) => page.evaluate((fail) => (window as unknown as { replyHome: (fail: boolean) => void }).replyHome(fail), fail);

test('loading reserves shelf space and retains the greeting when content arrives', async ({ page }) => {
  await pendingHome(page);
  const greeting = page.locator('.home-greeting');
  await greeting.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const position = await greeting.boundingBox();
  await expect(page.locator('.loading-shelf')).toHaveCount(2);
  await expect(page.locator('.home-loading button')).toHaveCount(0);
  const placeholder = await page.locator('.loading-cover').first().evaluate((node) => ({ width: (node as HTMLElement).offsetWidth, height: (node as HTMLElement).offsetHeight }));
  await page.screenshot({ path: 'test-results/tv-home-loading.png' });
  await reply(page);
  await expect(page.locator('[data-focus="series-story"]')).toBeFocused();
  await expect(page.getByLabel('正在加载媒体库')).toHaveCount(0);
  expect(await greeting.boundingBox()).toEqual(position);
  expect(await page.evaluate(() => (window as unknown as { greetingEntries: number }).greetingEntries)).toBe(1);
  // Compare layout size independently of the focused card's intentional zoom.
  const cover = await page.locator('.cover').first().evaluate((node) => ({ width: (node as HTMLElement).offsetWidth, height: (node as HTMLElement).offsetHeight }));
  expect(cover).toEqual(placeholder);
});

test('slow loading explains the wait and settings stays navigable before content arrives', async ({ page }) => {
  await page.clock.install();
  await pendingHome(page);
  await page.clock.fastForward(6500);
  await expect(page.getByRole('status')).toHaveText('加载较慢，请稍候…');
  await page.keyboard.press('ContextMenu');
  await expect(page.getByRole('heading', { name: '电视设置' })).toBeVisible();
  await expect(page.locator('[data-focus="check-update"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await reply(page);
  await expect(page.locator('[data-focus="series-story"]')).toBeFocused();
});

test('failed loading offers settings and retries into the same home layout', async ({ page }) => {
  await pendingHome(page);
  await reply(page, true);
  await expect(page.getByRole('alert')).toContainText('暂时无法连接媒体库');
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '打开设置' }).click();
  await expect(page.getByRole('heading', { name: '电视设置' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '打开设置' })).toBeFocused();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByLabel('正在加载媒体库')).toBeVisible();
  await reply(page);
  await expect(page.locator('[data-focus="series-story"]')).toBeFocused();
});

test('reduced motion keeps loading placeholders static', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pendingHome(page);
  expect(await page.locator('.home-loading').evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
  await reply(page);
  await expect(page.locator('[data-focus="series-story"]')).toBeFocused();
});
