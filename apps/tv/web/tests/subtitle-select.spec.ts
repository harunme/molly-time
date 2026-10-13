import { test, expect } from '@playwright/test';

test('subtitle dropdown supports remote selection, cancellation and save failure', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify({
    accessToken: 'test-access', refreshToken: 'test-refresh', deviceId: 'test-device', childId: '',
  })));
  await page.route('**/api/home', (route) => route.fulfill({ json: { rows: [] } }));
  await page.route('**/api/families/me/children', (route) => route.fulfill({ json: [] }));
  let saved = 'en', fail = false;
  const writes: string[] = [];
  await page.route('**/api/settings/playback', (route) => {
    if (route.request().method() === 'PUT') {
      const next = route.request().postDataJSON().defaultSubtitle;
      writes.push(next);
      if (fail) return route.fulfill({ status: 503, json: { detail: 'Unavailable' } });
      saved = next;
    }
    return route.fulfill({ json: { defaultSubtitle: saved } });
  });
  await page.goto('/tv/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const select = page.getByRole('combobox', { name: '默认字幕' });
  await expect(select).toHaveText('英文⌄');
  await expect(select).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: '重新配对', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(select).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option', { name: '英文', exact: true })).toBeFocused();
  await expect(page.getByRole('option')).toHaveCount(4);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(select).toBeFocused();
  await expect(page.getByRole('heading', { name: '电视设置' })).toBeVisible();
  expect(writes).toEqual([]);

  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: '中英文', exact: true })).toBeFocused();
  await page.screenshot({ path: 'test-results/subtitle-select-open.png' });
  await page.keyboard.press('Enter');
  await expect(select).toHaveText('中英文⌄');
  await expect(select).toBeFocused();
  expect(writes).toEqual(['zh-en']);
  await page.screenshot({ path: 'test-results/subtitle-select-closed.png' });
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: '重新配对', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(select).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: '关闭字幕' })).toBeFocused();
  await page.evaluate(() => window.mollyBack?.());
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(select).toHaveText('中英文⌄');
  expect(writes).toEqual(['zh-en']);

  fail = true;
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(select).toHaveText('中英文⌄');
  await expect(select).toBeFocused();
  expect(writes).toEqual(['zh-en', 'en']);
});
