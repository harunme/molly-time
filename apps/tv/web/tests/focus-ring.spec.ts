import { expect, test, type Locator } from '@playwright/test';

const ringStyle = (target: Locator) => target.evaluate(element => {
  const ring = getComputedStyle(element, '::before');
  return { animations: ring.animationName, durations: ring.animationDuration, content: ring.content, display: ring.display };
});

test('media artwork, settings buttons and dropdown options share the moving focus ring', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/tv/?mock=1');
  const cards = page.locator('.poster');
  await expect(cards.first()).toBeFocused();
  const artwork = cards.first().locator('.card-art');
  const reference = await ringStyle(artwork);
  expect(reference.animations).toContain('tv-focus-orbit');
  await expect(artwork).toHaveCSS('overflow', 'visible');
  await expect(artwork.locator('.cover')).toHaveCSS('overflow', 'hidden');
  // The highlight moves around the artwork without changing its dimensions.
  const start = await artwork.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight, angle: getComputedStyle(element, '::before').getPropertyValue('--tv-focus-angle') }));
  await expect.poll(() => artwork.evaluate(element => getComputedStyle(element, '::before').getPropertyValue('--tv-focus-angle'))).not.toBe(start.angle);
  expect(await artwork.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }))).toEqual({ width: start.width, height: start.height });
  await page.keyboard.press('ArrowRight');
  await expect(cards.nth(1)).toBeFocused();
  expect((await ringStyle(artwork)).content).toBe('none');
  expect(await ringStyle(cards.nth(1).locator('.card-art'))).toEqual(reference);
  await page.screenshot({ path: 'test-results/tv-shared-focus-media.png' });

  const settings = page.getByRole('button', { name: '打开设置', exact: true });
  await settings.focus();
  expect(await ringStyle(settings)).toEqual(reference);
  await settings.click();
  const entry = page.locator('[data-focus="open-live-tv"]');
  await entry.focus();
  expect(await ringStyle(entry)).toEqual(reference);
  await page.getByRole('combobox', { name: '默认字幕' }).click();
  const option = page.getByRole('option', { name: '中文', exact: true });
  await expect(option).toBeFocused();
  expect(await ringStyle(option)).toEqual(reference);
  await page.screenshot({ path: 'test-results/tv-shared-focus-select.png' });
});

test('reduced motion keeps a clear static focus ring on media and controls', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/tv/?mock=1');
  const card = page.locator('.poster').first();
  await expect(card).toBeFocused();
  const artwork = card.locator('.card-art');
  await expect(artwork).not.toHaveCSS('box-shadow', 'none');
  expect((await ringStyle(artwork)).display).toBe('none');
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const entry = page.locator('[data-focus="open-live-tv"]');
  await entry.focus();
  await expect(entry).not.toHaveCSS('box-shadow', 'none');
  await expect(entry).toHaveCSS('border-color', 'rgb(248, 222, 126)');
  expect((await ringStyle(entry)).display).toBe('none');
});
