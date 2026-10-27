import { expect, test } from '@playwright/test';

const pairing = (index = 0) => ({
  deviceCode: `test-secret-${index}`.padEnd(43, '0'), userCode: String(123 + index).padStart(4, '0'),
  verificationUri: `/manage/?pair=${String(123 + index).padStart(4, '0')}`, verificationUriManual: '/manage/',
  expiresAt: new Date(Date.now() + 600000).toISOString(), interval: 3,
});

test('repeated reloads reuse one live pairing; explicit renewal and expiry create new codes', async ({ page }) => {
  let starts = 0, cancellations = 0;
  await page.route('**/api/auth/pairing/start', route => {
    const result = pairing(starts++);
    return route.fulfill({ json: result });
  });
  await page.route('**/api/auth/pairing/poll', route => route.fulfill({ json: { status: 'pending' } }));
  await page.route('**/api/auth/pairing/cancel', route => { cancellations++; return route.fulfill({ json: { ok: true } }); });
  await page.goto('/tv/');
  await expect(page.locator('.pairing-code')).toHaveText('0123');
  for (let index = 0; index < 12; index++) {
    await page.reload();
    await expect(page.locator('.pairing-code')).toHaveText('0123');
  }
  expect(starts).toBe(1);
  expect(cancellations).toBe(0);
  await page.getByRole('button', { name: '刷新配对码', exact: true }).click();
  await expect(page.locator('.pairing-code')).toHaveText('0124');
  expect(starts).toBe(2);
  expect(cancellations).toBe(1);
  await page.evaluate(() => {
    const key = 'mollytime.tv.pairing.v1';
    const saved = JSON.parse(sessionStorage.getItem(key)!);
    saved.expiresAt = new Date(Date.now() - 1000).toISOString();
    sessionStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload();
  await expect(page.locator('.pairing-code')).toHaveText('0125');
  expect(starts).toBe(3);
});

test('rate-limit cooldown survives reloads and allows a retry after Retry-After', async ({ page }) => {
  let starts = 0;
  await page.clock.install();
  await page.route('**/api/auth/pairing/start', route => {
    starts++;
    return starts === 1
      ? route.fulfill({ status: 429, headers: { 'Retry-After': '4' }, json: { detail: '请求过于频繁，请稍后再试' } })
      : route.fulfill({ json: pairing() });
  });
  await page.route('**/api/auth/pairing/poll', route => route.fulfill({ json: { status: 'pending' } }));
  await page.goto('/tv/');
  const retry = page.locator('[data-focus="pairing-refresh"]');
  await expect(page.getByRole('alert')).toContainText('请求过于频繁');
  await expect(retry).toBeDisabled();
  await expect(retry).toContainText('秒后可重试');
  await page.reload();
  await expect(retry).toBeDisabled();
  await expect(retry).toContainText('秒后可重试');
  expect(starts).toBe(1);
  await page.clock.fastForward(5000);
  await expect(retry).toBeEnabled();
  expect(starts).toBe(1);
  await retry.click();
  await expect(page.locator('.pairing-code')).toHaveText('0123');
  expect(starts).toBe(2);
});
