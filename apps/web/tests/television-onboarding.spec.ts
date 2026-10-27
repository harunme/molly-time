import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/manage/#/overview');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
}

test('first TV setup opens from overview, preserves history and offers an APK download on mobile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/manage/reminders/devices', route => route.fulfill({ json: [] }));
  await login(page);
  const onboarding = page.getByLabel('连接第一台电视', { exact: true });
  await expect(onboarding).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('first-tv-mobile.png'), fullPage: true });
  const trigger = page.locator('.page-title').getByRole('button', { name: '绑定电视', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '绑定电视', exact: true });
  await expect(page).toHaveURL(/#\/overview\?pair=1$/);
  await expect(dialog.getByLabel('电视配对码')).toBeFocused();
  await expect(dialog).toContainText('打开电视上的 MollyTime');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(/#\/overview$/);
  await page.goForward();
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await onboarding.getByRole('button', { name: '电视还没安装？', exact: true }).click();
  await expect(dialog.locator('details')).toHaveAttribute('open', '');
  await expect(dialog).toContainText('U 盘');
  await expect(dialog).toContainText('Android 电视');
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载电视安装包', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^mollytime-tv(?:-[\d.]+)?\.apk$/);
  await expect(dialog.getByRole('status')).toContainText('请将安装包转移到电视');
  await page.screenshot({ path: testInfo.outputPath('tv-install-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('overview follows active bindings, including offline TVs, without treating an error as zero', async ({ page }) => {
  let state: 'loading' | 'empty' | 'offline' | 'error' = 'loading';
  await page.route('**/api/manage/reminders/devices', async route => {
    if (state === 'loading') return route.fulfill({ status: 503, json: { detail: '暂时无法读取设备' } });
    if (state === 'error') return route.fulfill({ status: 503, json: { detail: '暂时无法读取设备' } });
    await route.fulfill({ json: state === 'empty' ? [] : [{ id: 'offline-tv', name: '客厅电视', online: false, phase: 'idle', lastSeen: null }] });
  });
  await login(page);
  const onboarding = page.getByLabel('连接第一台电视', { exact: true });
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  await expect(onboarding).toHaveCount(0);
  state = 'empty';
  await page.evaluate(() => window.dispatchEvent(new Event('molly:watch-controlChanged')));
  await expect(onboarding).toBeVisible();
  state = 'offline';
  await page.evaluate(() => window.dispatchEvent(new Event('molly:watch-controlChanged')));
  await expect(onboarding).toHaveCount(0);
  state = 'empty';
  await page.evaluate(() => window.dispatchEvent(new Event('molly:watch-controlChanged')));
  await expect(onboarding).toBeVisible();
  state = 'error';
  await page.evaluate(() => window.dispatchEvent(new Event('molly:watch-controlChanged')));
  await expect(onboarding).toHaveCount(0);
});

test('installation handles missing releases and failed requests and can retry', async ({ page }) => {
  await login(page);
  await page.locator('.page-title').getByRole('button', { name: '绑定电视', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '绑定电视', exact: true });
  await dialog.locator('summary').click();
  const button = dialog.getByRole('button', { name: '下载电视安装包', exact: true });
  let mode: 'missing' | 'error' | 'invalid' = 'missing';
  await page.route('**/api/client/releases/latest', route => {
    if (mode === 'error') return route.fulfill({ status: 503, json: {} });
    if (mode === 'invalid') return route.fulfill({ json: { release: { packageName: 'com.molly.tv', versionName: '1', size: 20, url: 'https://external.test/app.apk' } } });
    return route.fulfill({ json: { release: null } });
  });
  await button.click();
  await expect(dialog.getByRole('status')).toContainText('尚未发布');
  mode = 'error'; await button.click();
  await expect(dialog.getByRole('status')).toContainText('请重试');
  mode = 'invalid'; await button.click();
  await expect(dialog.getByRole('status')).toContainText('安装包地址无效');
  await expect(button).toBeEnabled();
});

test('members can read installation instructions but cannot submit a pairing request', async ({ page }) => {
  await page.route('**/api/manage/auth/session', async route => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const session = await response.json();
    await route.fulfill({ json: { ...session, user: { ...session.user, role: 'member' } } });
  });
  await login(page);
  await page.reload();
  await page.locator('.page-title').getByRole('button', { name: '如何绑定电视', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '绑定电视', exact: true });
  await expect(dialog).toContainText('请家庭管理员完成绑定');
  await expect(dialog.getByLabel('电视配对码')).toHaveCount(0);
  await dialog.locator('summary').click();
  await expect(dialog.getByRole('button', { name: '下载电视安装包', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认绑定这台电视', exact: true })).toHaveCount(0);
});

test('confirmation submits once and setup remains until the TV claims its binding', async ({ page }) => {
  let claimed = false, lookups = 0, confirmations = 0;
  await page.route('**/api/manage/reminders/devices', route => route.fulfill({ json: claimed ? [{ id: 'new-tv', name: '新电视', online: true, phase: 'idle' }] : [] }));
  await page.route('**/api/manage/pairing/0123', route => {
    lookups++;
    return route.fulfill({ json: { name: '新电视', expiresAt: '2099-01-01T00:00:00Z' } });
  });
  await page.route('**/api/manage/pairing/confirm', route => {
    confirmations++;
    return route.fulfill({ json: { ok: true } });
  });
  await login(page);
  await page.locator('.page-title').getByRole('button', { name: '绑定电视', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '绑定电视', exact: true });
  await dialog.getByLabel('电视配对码').fill('0123');
  const submitTwice = () => dialog.locator('form').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
  await submitTwice();
  await expect(dialog.getByLabel('电视名称')).toHaveValue('新电视');
  expect(lookups).toBe(1);
  await submitTwice();
  await expect(page.getByRole('dialog', { name: '已确认绑定', exact: true })).toBeVisible();
  expect(confirmations).toBe(1);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  const onboarding = page.getByLabel('连接第一台电视', { exact: true });
  await expect(onboarding).toBeVisible();
  claimed = true;
  await page.evaluate(() => window.dispatchEvent(new Event('molly:watch-controlChanged')));
  await expect(onboarding).toHaveCount(0);
});
