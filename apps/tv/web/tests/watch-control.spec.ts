import { expect, test } from '@playwright/test';
import type { BrowserWatchGuard } from '../src/watch-control';

declare global { interface Window { testWatchGuard: BrowserWatchGuard } }

const state = (id = 'today', version = 1) => ({
  enabled: true, supported: true, version, acknowledged: version, mode: 'episodes', amount: 2, status: 'allowed',
  serverTime: 1000000, resetsAt: 1001000,
  round: { id, mode: 'episodes', amount: 2, limitMs: 0, playedMs: 0, cursor: 0, playlist: ['episode'], episodeId: 'episode', ended: false },
});

test.beforeEach(async ({ page }) => {
  await page.route('**/tv/guard-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Watch guard test</title>' }));
  await page.route('**/api/watch-control**', route => route.fulfill({ json: state() }));
  await page.clock.install();
  await page.goto('/tv/guard-test');
  await page.evaluate(async () => {
    const path = '/tv/src/watch-control.tsx';
    const { BrowserWatchGuard } = await import(path);
    window.testWatchGuard = new BrowserWatchGuard();
    await window.testWatchGuard.open();
  });
});

test('daily expiry stops playback even when local wall clock is moved backward', async ({ page }) => {
  expect(await page.evaluate(() => window.testWatchGuard.sample(true))).toBe(true);
  await page.clock.setSystemTime(new Date('2000-01-01'));
  await page.clock.fastForward(1100);
  expect(await page.evaluate(() => window.testWatchGuard.sample(true))).toBe(false);
  expect(await page.evaluate(() => window.testWatchGuard.state?.round?.id)).toBe('today');
});

test('new day stops an old session without charging or completing the new allowance', async ({ page }) => {
  expect(await page.evaluate(() => window.testWatchGuard.sample(true))).toBe(true);
  await page.route('**/api/watch-control/sync', route => route.fulfill({ json: { ...state('tomorrow', 2), resetsAt: 90000000 } }));
  const result = await page.evaluate(async () => {
    const guard = window.testWatchGuard;
    await guard.sync();
    const allowed = guard.sample(true);
    guard.complete('episode');
    return { allowed, round: guard.state?.round };
  });
  expect(result.allowed).toBe(false);
  expect(result.round?.id).toBe('tomorrow');
  expect(result.round?.cursor).toBe(0);
  expect(result.round?.playedMs).toBe(0);
});
