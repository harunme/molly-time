import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page, mode: 'episodes' | 'minutes' = 'episodes', allowed = false) {
  await page.addInitScript(({ mode, allowed }) => {
    const w = window as any;
    w.played = [];
    w.watch = { supported: true, enabled: true, pinSet: true, mode, amount: 1,
      version: 1, acknowledged: 1, status: allowed ? 'allowed' : 'resting',
      round: { id: 'today', mode, amount: 1, cursor: allowed ? 0 : 1,
        limitMs: 600000, remainingMs: allowed ? 600000 : 0, playedMs: allowed ? 0 : 600000,
        playlist: ['episode'], episodeId: allowed ? 'episode' : null, ended: !allowed } };
    const episode = { id: 'episode', type: 'episode', name: '森林里的故事', runtimeMs: 1200000 };
    w.MollyBridge = { postMessage(raw: string) {
      const { id, method, args } = JSON.parse(raw);
      let result: any = { ok: true }, error: any;
      if (method === 'getCapabilities') result = { bridgeVersion: 1, authenticated: true, nativePlayback: true, watchControl: true, serverUrl: 'https://media.test' };
      if (method === 'playEpisode') w.played.push(args.episodeId);
      if (method === 'request') {
        if (args.path.startsWith('/api/watch-control')) {
          if (args.path.endsWith('/commands')) {
            if (args.body.pin !== '1234') error = { message: '家长密码不正确', status: 403 };
            else {
              w.watch.version++;
              if (args.body.action === 'add') {
                w.watch.status = 'allowed'; w.watch.round.ended = false;
                w.watch.round.amount++; w.watch.round.remainingMs = 600000;
              }
            }
          }
          if (w.failRecheck && args.method === 'GET' && w.watch.version > 1) {
            w.watch.status = 'resting'; w.watch.round.ended = true;
          }
          result = w.watch;
        } else if (args.path.split('?')[0] === '/api/home') result = { rows: [{ id: 'library', title: '我的媒体库', items: [{ id: 'folder', name: '故事收藏', type: 'folder' }] }] };
        else if (args.path.includes('/playlist')) result = { items: [episode], itemTotal: 1, itemsHasMore: false, episodes: [episode], total: 1, hasMore: false, hasProgress: false };
      }
      setTimeout(() => w.MollyBridge.onmessage?.({ data: JSON.stringify(error ? { id, error } : { id, result }) }), 5);
    } };
  }, { mode, allowed });
  await page.goto('/tv/');
  await page.locator('[data-focus="series-folder"]').click();
  await expect(page.locator('[data-focus="episode-episode"]')).toBeVisible();
}

async function authorize(page: Page, pin = '1234') {
  await page.locator('[data-focus="watch-parent-main"]').click();
  for (const digit of pin) await page.locator(`[data-focus="watch-digit-${digit}"]`).click();
}

test('adding allowance plays the blocked selection and preserves its directory on return', async ({ page }) => {
  await setup(page);
  await page.locator('[data-focus="episode-episode"]').click();
  await expect(page.locator('[data-focus="watch-parent-main"]')).toContainText('并继续观看');
  await authorize(page);
  await expect.poll(() => page.evaluate(() => (window as any).played)).toEqual(['episode']);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('molly:playbackClosed')));
  await expect(page.locator('[data-focus="episode-episode"]')).toBeFocused();
  await expect(page.locator('.detail-header')).toContainText('故事收藏');
});

test('canceling authorization returns to the selected video and clears playback intent', async ({ page }) => {
  await setup(page);
  await page.locator('[data-focus="episode-episode"]').click();
  await page.locator('[data-focus="watch-parent-main"]').click();
  await expect(page.locator('.watch-pin-summary')).toContainText('森林里的故事');
  await page.locator('[data-focus="watch-pin-cancel"]').click();
  await page.locator('[data-focus="close-overlay"]').click();
  await expect(page.locator('[data-focus="episode-episode"]')).toBeFocused();
  await page.keyboard.press('ContextMenu');
  await page.locator('[data-focus="open-watch-control"]').click();
  await authorize(page);
  await expect(page.locator('[data-focus="open-watch-control"]')).toBeFocused();
  expect(await page.evaluate(() => (window as any).played)).toEqual([]);
});

test('wrong PIN keeps the selection pending until authorization succeeds', async ({ page }) => {
  await setup(page);
  await page.locator('[data-focus="episode-episode"]').click();
  await authorize(page, '9999');
  await expect(page.getByRole('alert')).toContainText('家长密码不正确');
  expect(await page.evaluate(() => (window as any).played)).toEqual([]);
  for (const digit of '1234') await page.locator(`[data-focus="watch-digit-${digit}"]`).click();
  await expect.poll(() => page.evaluate(() => (window as any).played)).toEqual(['episode']);
});

test('adding time after interrupted playback resumes that episode', async ({ page }) => {
  await setup(page, 'minutes', true);
  await page.locator('[data-focus="episode-episode"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).played)).toEqual(['episode']);
  await page.evaluate(() => {
    const w = window as any;
    w.watch.status = 'resting'; w.watch.round.ended = true; w.watch.round.remainingMs = 0;
    window.dispatchEvent(new CustomEvent('molly:playbackClosed', { detail: {
      episodeId: 'episode', positionMs: 600000, completed: false, runtimeMs: 1200000, progressKnown: true,
    } }));
  });
  await page.locator('[data-focus="watch-rest-parent"]').click();
  await authorize(page);
  await expect.poll(() => page.evaluate(() => (window as any).played)).toEqual(['episode', 'episode']);
});


test('switching away from the final allocated episode resumes the newly selected video after adding', async ({ page }) => {
  await setup(page, 'episodes', true);
  await page.evaluate(() => {
    const state = (window as any).watch;
    state.round.episodeId = 'other'; state.round.playlist = ['other'];
  });
  await page.locator('[data-focus="episode-episode"]').click();
  await expect(page.locator('[data-focus="watch-parent-main"]')).toContainText('并继续观看');
  await authorize(page);
  await expect.poll(() => page.evaluate(() => (window as any).played)).toEqual(['episode']);
});

test('resuming rechecks current allowance instead of trusting an earlier command response', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).failRecheck = true; });
  await page.locator('[data-focus="episode-episode"]').click();
  await authorize(page);
  await expect(page.locator('[data-focus="watch-parent-main"]')).toBeVisible();
  expect(await page.evaluate(() => (window as any).played)).toEqual([]);
});
