import { test, expect } from '@playwright/test';

// Run against `pnpm build` with playwright.pwa.config.ts, never Vite's dev shell.
test('production app installs a complete shell, starts offline and reconnects without caching private data', async ({ page, context }) => {
  await page.goto('/manage/');
  const manifest = await (await page.request.get('/manage/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ start_url: '/manage/', scope: '/manage/', display: 'standalone' });
  for (const icon of manifest.icons) {
    const response = await page.request.get(`/manage/${icon.src}`);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('image/png');
  }
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    return (await Promise.all(keys.map(async key => (await (await caches.open(key)).keys()).map(request => request.url)))).flat();
  });
  expect(cached.some(url => url.includes('/assets/') && url.endsWith('.js'))).toBe(true);
  expect(cached.some(url => url.includes('/api/') || url.includes('/tv/'))).toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '暂时无法连接' })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('pwa-reconnected.png') });
});

test('an installed app waits for explicit update and cleans obsolete shell caches', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  const { readFile, writeFile } = await import('node:fs/promises');
  const path = 'dist/sw.js';
  const original = await readFile(path, 'utf8');
  try {
    await page.goto('/manage/');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await writeFile(path, original.replace(/mollytime-shell-([a-f0-9]+)/g, 'mollytime-shell-$1-update-test'));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration('/manage/'))!.update(); });
    await expect(page.getByRole('button', { name: '更新应用', exact: true })).toBeVisible();
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/manage/'))?.waiting?.state)).toBe('installed');
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: '更新应用', exact: true }).click()]);
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(key => key.startsWith('mollytime-shell-')))).toEqual([expect.stringContaining('-update-test')]);
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  } finally { await writeFile(path, original); }
});

test('a browser tab activates a new shell without an update banner or reload', async ({ page }) => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const path = 'dist/sw.js';
  const original = await readFile(path, 'utf8');
  try {
    await page.goto('/manage/');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.getByLabel('账号', { exact: true }).fill('keep-my-input@example.test');
    await writeFile(path, original.replace(/mollytime-shell-([a-f0-9]+)/g, 'mollytime-shell-$1-browser-update'));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration('/manage/'))!.update(); });
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter(key => key.startsWith('mollytime-shell-')))).toEqual([expect.stringContaining('-browser-update')]);
    await expect(page.getByRole('button', { name: '更新应用', exact: true })).toHaveCount(0);
    await expect(page.getByText('新版本已准备好')).toHaveCount(0);
    await expect(page.getByLabel('账号', { exact: true })).toHaveValue('keep-my-input@example.test');
  } finally { await writeFile(path, original); }
});
