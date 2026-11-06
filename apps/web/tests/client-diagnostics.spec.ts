import { test, expect, type Page } from '@playwright/test';
import { chooseSelect } from './select';

async function login(page: Page, user = 'operator@example.test', secret = 'operator-e2e') {
  await page.getByLabel('账号', { exact: true }).fill(user);
  await page.getByLabel('密码', { exact: true }).fill(secret);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '账号菜单' })).toBeVisible();
}
async function logout(page: Page) {
  await page.getByRole('button', { name: '账号菜单' }).click();
  await page.getByRole('menuitem', { name: '退出账号', exact: true }).click();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
}
async function crash(page: Page, name: string) {
  await page.evaluate((name) => {
    const error = new Error('private exception message token=do-not-upload'); error.name = name;
    error.stack = `${name}: private exception message\n    at changeCover (https://private.example/assets/cover.js:77:12?token=do-not-upload)`;
    window.dispatchEvent(new ErrorEvent('error', { error }));
  }, name);
}

test('runtime errors reach operator logs with sanitized frames and readable mobile details', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/manage/'); await login(page);
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  const reported = page.waitForResponse((response) => response.url().endsWith('/api/client/error-logs') && response.request().method() === 'POST');
  await crash(page, 'CoverDiagnosticFixture');
  const response = await reported;
  expect(response.status()).toBe(200);
  const body = response.request().postDataJSON();
  expect(body.source).toBe('web-parent'); expect(body.screen).toBe('page.overview');
  expect(JSON.stringify(body)).not.toContain('do-not-upload');
  expect(JSON.stringify(body)).not.toContain('private.example');
  expect(body.stack[0]).toContain('cover.js:77:12');
  await page.getByRole('navigation').getByRole('link', { name: '系统日志', exact: true }).click();
  const entry = page.locator('article').filter({ hasText: 'CoverDiagnosticFixture' });
  await expect(entry).toBeVisible();
  await entry.getByText('查看异常栈和最近操作').click();
  await expect(entry.locator('pre')).toBeVisible();
  await expect(entry).toContainText('cover.js:77:12');
  await expect(entry.getByRole('list', { name: '最近操作' })).toContainText('screen:page.overview');
  await page.screenshot({ path: '/tmp/molly-client-diagnostics-desktop.png', fullPage: true });
  await chooseSelect(page.getByLabel('日志客户端'), 'ios-parent');
  await expect(page.getByText('暂无客户端异常', { exact: true })).toBeVisible();
  await chooseSelect(page.getByLabel('日志客户端'), 'web-parent');
  await expect(entry).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await entry.getByText('查看异常栈和最近操作').click();
  await expect(entry.locator('pre')).toBeVisible();
  await expect(entry).toContainText('cover.js:77:12');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/molly-client-diagnostics-mobile.png', fullPage: true });
});

test('offline reports keep their IDs across reloads and wait for their original account', async ({ page }) => {
  let online = false;
  const attempts: { id: string; errorType: string }[] = [];
  await page.route('**/api/client/error-logs', async (route) => {
    attempts.push(route.request().postDataJSON());
    if (online) await route.continue(); else await route.abort();
  });
  await page.goto('/manage/'); await login(page);
  await crash(page, 'OfflineDiagnosticFixture');
  await expect.poll(() => attempts.length).toBe(1);
  const id = attempts[0].id;
  await page.reload();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1].id).toBe(id);
  await logout(page);
  online = true;
  const count = attempts.length;
  await login(page, 'receiver@example.test', 'receiver-e2e');
  await page.getByRole('navigation').getByRole('link', { name: '资源库', exact: true }).click();
  expect(attempts.length).toBe(count);
  await logout(page);
  const sent = page.waitForResponse((response) => response.url().endsWith('/api/client/error-logs') && response.request().postDataJSON()?.id === id);
  await login(page);
  expect((await sent).status()).toBe(200);
  expect(attempts.at(-1)?.id).toBe(id);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mollytime.diagnostics.web-parent.v1') || '[]').length)).toBe(0);
});
