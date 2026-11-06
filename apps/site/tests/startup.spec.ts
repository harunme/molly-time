import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

declare global {
  interface Window { startupAudio?: HTMLAudioElement; startupPlayAttempts: number; }
}

async function audioPolicy(page: Page, mode: 'blocked' | 'broken' | 'pending') {
  await page.addInitScript((policy) => {
    const play = HTMLMediaElement.prototype.play;
    window.startupPlayAttempts = 0;
    HTMLMediaElement.prototype.play = function () {
      if (this.tagName !== 'AUDIO') return play.call(this);
      window.startupAudio = this as HTMLAudioElement;
      window.startupPlayAttempts++;
      if (policy === 'pending') return new Promise<void>(() => {});
      return Promise.reject(new DOMException('Test playback policy', policy === 'broken' ? 'NotSupportedError' : 'NotAllowedError'));
    };
  }, mode);
}

test('blocked autoplay keeps the full native animation, then enters without delayed sound', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await audioPolicy(page, 'blocked');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const intro = page.locator('#startup-intro');
  await expect(intro).toHaveAttribute('data-playback', 'silent');
  await expect(intro.getByRole('button')).toHaveCount(0);
  await expect(page.locator('[data-site-content]')).toHaveJSProperty('inert', true);
  await expect(page.locator('.startup-backdrop')).toHaveCSS('background-color', 'rgb(33, 31, 27)');
  await expect(page.locator('[data-site-content]')).toHaveCSS('visibility', 'visible');
  await expect.poll(() => page.locator('.startup-symbol').evaluate(element => Number(element.getAnimations({ subtree: true })[0]?.currentTime))).toBeGreaterThan(400);
  const shade = page.locator('.startup-backdrop');
  const midOpacity = Number(await shade.evaluate(element => getComputedStyle(element).opacity));
  expect(midOpacity).toBeGreaterThan(0);
  expect(midOpacity).toBeLessThan(0.95);
  await expect.poll(() => shade.evaluate(element => Number(getComputedStyle(element).opacity))).toBeLessThan(0.2);
  await expect(intro).toBeHidden({ timeout: 4000 });
  await expect(shade).toHaveCSS('opacity', '0');
  await expect(page.locator('.startup-symbol')).toHaveCSS('opacity', '0');
  await expect(page.locator('[data-site-content]')).toHaveJSProperty('inert', false);
  await page.getByRole('button', { name: '切换深浅色主题' }).click();
  expect(await page.evaluate(() => window.startupPlayAttempts)).toBe(1);
  expect(errors).toEqual([]);
  await page.getByRole('link', { name: '使用说明', exact: true }).click();
  await expect(page.locator('#startup-intro')).toBeHidden();
  expect(await page.evaluate(() => window.startupPlayAttempts)).toBe(0);
});

test('every homepage reload replays the intro without controls or session suppression', async ({ page }) => {
  await audioPolicy(page, 'blocked');
  // A marker left by an earlier version must not suppress the new behavior.
  await page.addInitScript(() => sessionStorage.setItem('mollytime-site-entered', '1'));
  await page.goto('/');
  await expect(page.locator('#startup-intro')).toHaveAttribute('data-playback', 'silent');
  await expect(page.locator('#startup-intro')).toBeVisible();
  await expect(page.locator('#startup-intro button')).toHaveCount(0);
  await expect(page.locator('#startup-intro')).toBeHidden();
  await page.reload();
  await expect(page.locator('#startup-intro')).toBeVisible();
  await expect(page.locator('#startup-intro')).toHaveAttribute('data-playback', 'silent');
  expect(await page.evaluate(() => window.startupPlayAttempts)).toBe(1);
  await expect(page.locator('#startup-intro')).toBeHidden();
  await page.goto('/terms');
  await expect(page.locator('#startup-intro')).toHaveCount(0);
  await page.locator('main').getByRole('link', { name: '返回 MollyTime 首页' }).click();
  await expect(page.locator('#startup-intro')).toBeVisible();
  await expect(page.locator('#startup-intro')).toBeHidden();
});

test('reduced motion uses a static mark and a failed sound never blocks entry', async ({ page }) => {
  await audioPolicy(page, 'broken');
  await page.goto('/');
  await expect(page.locator('#startup-intro')).toHaveAttribute('data-playback', 'silent');
  expect(await page.locator('.startup-symbol').evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(page.locator('#startup-intro button')).toHaveCount(0);
  await expect(page.locator('#startup-intro')).toBeHidden({ timeout: 2000 });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('a stalled audio request times out and cannot hold the page open', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await audioPolicy(page, 'pending');
  await page.goto('/');
  await expect(page.locator('#startup-intro')).toHaveAttribute('data-playback', 'silent', { timeout: 2000 });
  await expect(page.locator('#startup-intro')).toBeHidden({ timeout: 4000 });
  expect(await page.evaluate(() => window.startupAudio?.paused)).toBe(true);
  await expect(page.locator('[data-site-content]')).toHaveJSProperty('inert', false);
});

test('missing module JavaScript still releases the entry overlay', async ({ page }) => {
  await page.route('**/', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/<script\b[^>]*type="module"[^>]*>[\s\S]*?<\/script>/g, '');
    await route.fulfill({ response, body });
  });
  await page.goto('/');
  await expect(page.locator('#startup-intro')).toBeVisible();
  await expect(page.locator('#startup-intro')).toBeHidden({ timeout: 4000 });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('without JavaScript the content is visible immediately', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.locator('#startup-intro')).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: '使用说明', exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test('the shipped sound matches the verified release manifest', async ({ page }) => {
  await page.goto('/?preview=share');
  const config = JSON.parse(await readFile(new URL('../src/assets/startup/config.json', import.meta.url), 'utf8'));
  const sound = await page.locator('#startup-intro').getAttribute('data-sound');
  if (!config.configured) { expect(sound).toBeNull(); return; }
  const response = await page.request.get(sound!);
  expect(response.status()).toBe(200);
  expect(createHash('sha256').update(await response.body()).digest('hex')).toBe(config.version);
});
