import { test, expect, type Page } from '@playwright/test';

async function openCatalog(page: Page, count = 1) {
  await page.addInitScript((count) => {
    const w = window as any;
    w.refreshStatus = 200; w.holdRefresh = false; w.held = []; w.catalogRequests = [];
    w.releaseRefresh = () => { w.holdRefresh = false; w.held.splice(0).forEach((reply: () => void) => reply()); };
    w.MollyBridge = { postMessage(raw: string) {
      const { id, method, args } = JSON.parse(raw);
      let result: unknown = { ok: true }, catalog = false;
      if (method === 'getCapabilities') result = { bridgeVersion: 1, authenticated: true, nativePlayback: true, serverUrl: 'https://media.example.test' };
      if (method === 'request') {
        const url = new URL(args.path, location.origin), batch = Number(url.searchParams.get('page') || 1);
        if (url.pathname === '/api/home') {
          catalog = true;
          result = { rows: [{ id: 'library', title: '我的媒体库', hasMore: false,
            items: Array.from({ length: count }, (_, i) => ({ id: `folder-${i}`, name: `故事 ${i}` })) }] };
        }
        if (url.pathname.endsWith('/playlist')) {
          catalog = batch === 1;
          result = { page: batch, total: 72, hasMore: batch < 3, episodeId: null, hasProgress: false,
            episodes: Array.from({ length: 24 }, (_, i) => ({ id: `e-${(batch - 1) * 24 + i}`, name: `视频 ${(batch - 1) * 24 + i}`, runtimeMs: 60000 })) };
        }
        if (url.pathname === '/api/home' || url.pathname.endsWith('/playlist')) w.catalogRequests.push(args.path);
      }
      const reply = () => w.MollyBridge.onmessage?.({ data: JSON.stringify(catalog && w.refreshStatus !== 200
        ? { id, error: { status: w.refreshStatus, message: '刷新失败' } } : { id, result }) });
      if (catalog && w.holdRefresh) w.held.push(reply);
      else setTimeout(reply, 5);
    } };
  }, count);
  await page.goto('/tv/');
  await expect(page.locator('[data-focus="series-folder-0"]')).toBeFocused();
}

test('remote navigation has bounded geometry reads in a 960-card grid and adapts to resize', async ({ page }) => {
  await openCatalog(page, 960);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-focus="series-folder-0"]')).toBeFocused();
  await page.evaluate(() => {
    const w = window as any; w.geometryReads = 0;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')!;
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { ...descriptor, get() {
      w.geometryReads++; return descriptor.get!.call(this);
    } });
  });
  for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp'); }
  // The old implementation performed over 23,000 offsetTop reads here.
  const reads = await page.evaluate(() => (window as any).geometryReads);
  expect(reads).toBeLessThan(500);
  await test.info().attach('navigation-cost', {
    body: JSON.stringify({ cards: 960, presses: 12, offsetTopReads: reads }), contentType: 'application/json',
  });
  await page.setViewportSize({ width: 600, height: 1000 });
  const columns = await page.locator('.episode-grid').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`[data-focus="series-folder-${columns}"]`)).toBeFocused();
});

test('playback return retains card DOM and remains navigable during a delayed refresh', async ({ page }) => {
  await openCatalog(page); await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="episode-e-0"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const w = window as any;
    w.retainedCard = document.querySelector('[data-focus="episode-e-0"]'); w.holdRefresh = true;
    window.dispatchEvent(new CustomEvent('molly:playbackClosed'));
  });
  await expect.poll(() => page.evaluate(() => (window as any).held.length)).toBe(1);
  await expect(page.getByText('正在加载内容…', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).retainedCard === document.querySelector('[data-focus="episode-e-0"]'))).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="episode-e-1"]')).toBeFocused();
  await page.evaluate(() => (window as any).releaseRefresh());
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('[data-focus="episode-e-1"]')).toBeFocused();
});

test('a background refresh cannot overwrite pages appended while it was pending', async ({ page }) => {
  await openCatalog(page); await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="episode-e-0"]')).toBeFocused();
  await page.evaluate(() => { (window as any).holdRefresh = true; window.dispatchEvent(new CustomEvent('molly:playbackClosed')); });
  await expect.poll(() => page.evaluate(() => (window as any).held.length)).toBe(1);
  await page.locator('[data-focus="episode-e-18"]').focus();
  await expect(page.locator('.episode-shelf .poster')).toHaveCount(48);
  await page.evaluate(() => (window as any).releaseRefresh());
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.episode-shelf .poster')).toHaveCount(48);
  await expect(page.locator('[data-focus="episode-e-18"]')).toBeFocused();
});

for (const status of [503, 401]) {
  test(`background refresh handles ${status} without losing the session rules`, async ({ page }) => {
    await openCatalog(page);
    await page.evaluate((status) => {
      (window as any).refreshStatus = status; window.dispatchEvent(new CustomEvent('molly:playbackClosed'));
    }, status);
    if (status === 503) {
      await expect(page.getByRole('status')).toContainText('仍可继续浏览');
      await expect(page.locator('[data-focus="series-folder-0"]')).toBeFocused();
      await page.evaluate(() => { (window as any).refreshStatus = 200; });
      await page.getByRole('button', { name: '重试更新' }).click();
      await expect(page.locator('.catalog-notice')).toHaveCount(0);
    } else {
      await expect(page.getByRole('button', { name: '绑定家庭媒体库' })).toBeVisible();
      await expect(page.locator('.poster')).toHaveCount(0);
    }
  });
}

test('native return patches progress without reloading or replacing the cached cards', async ({ page }) => {
  await openCatalog(page); await page.keyboard.press('Enter');
  const card = page.locator('[data-focus="episode-e-0"]');
  await expect(card).toBeFocused(); await page.keyboard.press('Enter');
  const requests = await page.evaluate(() => (window as any).catalogRequests.length);
  await page.evaluate(() => {
    (window as any).retainedCard = document.querySelector('[data-focus="episode-e-0"]');
    (window as any).holdRefresh = true;
    window.dispatchEvent(new CustomEvent('molly:playbackClosed', { detail: {
      episodeId: 'e-0', positionMs: 15000, runtimeMs: 60000, completed: false, progressKnown: true,
    } }));
  });
  await expect(card).toBeFocused();
  await expect(card.locator('.cover-action')).toContainText('继续观看 · 已看 00:15 / 01:00');
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  expect(await page.evaluate(() => (window as any).retainedCard === document.querySelector('[data-focus="episode-e-0"]'))).toBe(true);
  expect(await page.evaluate(() => (window as any).catalogRequests.length)).toBe(requests);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus="episode-e-1"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="series-folder-0"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card).toBeFocused();
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  expect(await page.evaluate(() => (window as any).catalogRequests.length)).toBe(requests);
});

test('completed native return keeps exit focus and updates the next resume episode', async ({ page }) => {
  await openCatalog(page); await page.keyboard.press('Enter');
  const card = page.locator('[data-focus="episode-e-0"]');
  await expect(card).toBeFocused(); await page.keyboard.press('Enter');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:playbackClosed', { detail: {
    episodeId: 'e-0', positionMs: 60000, runtimeMs: 60000, completed: true, progressKnown: true,
  } })));
  await expect(card).toBeFocused();
  await expect(page.locator('[data-focus="episode-e-1"] .cover-action')).toContainText('继续观看');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus="series-folder-0"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus="episode-e-0"]')).toBeFocused();
});

for (const detail of [
  { episodeId: 'e-0', positionMs: -1, completed: false, progressKnown: true },
  { episodeId: 'e-0', positionMs: 15000, completed: false, progressKnown: false },
  { episodeId: 'e-70', positionMs: 15000, completed: false, progressKnown: true },
  { episodeId: 'e-23', positionMs: 60000, completed: true, progressKnown: true },
]) {
  test(`return refresh fallback: ${JSON.stringify(detail)}`, async ({ page }) => {
    await openCatalog(page); await page.keyboard.press('Enter');
    await expect(page.locator('[data-focus="episode-e-0"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.evaluate((detail) => {
      (window as any).holdRefresh = true;
      window.dispatchEvent(new CustomEvent('molly:playbackClosed', { detail }));
    }, detail);
    await expect.poll(() => page.evaluate(() => (window as any).held.length)).toBe(1);
    await expect(page.locator('[data-focus="episode-e-0"]')).toBeFocused();
    await expect(page.locator('.poster')).toHaveCount(24);
    await page.evaluate(() => (window as any).releaseRefresh());
  });
}
