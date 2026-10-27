import { chooseSelect } from './select';
import { expect, test, type Page } from '@playwright/test';
const apiOrigin = `http://127.0.0.1:${process.env.MOLLYTIME_E2E_PORT || '8098'}`;

async function setup(page: Page) {
  const auth = await (await page.request.post(`${apiOrigin}/api/auth/login`, { headers: { 'X-Molly-Client': 'tv-shell/2' }, data: { username: 'parent@example.test', password: 'parent' + '-e2e' } })).json();
  const headers = { Authorization: `Bearer ${auth.accessToken}` };
  await page.request.post('/api/manage/auth/login', { data: { username: 'parent@example.test', password: 'parent' + '-e2e' } });
  const parent = await (await page.request.get('/api/manage/auth/session')).json();
  const parentHeaders = { 'X-CSRF-Token': parent.csrfToken };
  await page.request.put('/api/manage/watch-control/pin', { headers: parentHeaders, data: { pin: '1234' } });
  const read = async () => (await (await page.request.get(`${apiOrigin}/api/watch-control`, { headers })).json());
  const command = async (action: string, extra = {}) => {
    const current = await read();
    const result = await page.request.post(`/api/manage/watch-control/${auth.deviceId}/commands`, { headers: parentHeaders, data: { requestId: crypto.randomUUID(), version: current.version, action, ...extra } });
    expect(result.ok()).toBe(true); return result.json();
  };
  await page.addInitScript(binding => localStorage.setItem('mollytime.tv.binding.v1', JSON.stringify(binding)), auth);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return { auth, headers, parentHeaders, read, command };
}
async function openControls(page: Page) {
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.locator('[data-focus="open-watch-control"]').click();
}
async function openFolder(page: Page) {
  await page.locator('[data-focus$="-series"]').click();
  await page.locator('[data-focus="folder-season"]').click();
}

test('daily quota is immediately usable, survives reload, and rest only blocks playback', async ({ page }, testInfo) => {
  const { auth, parentHeaders, read } = await setup(page);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.request.patch(`/api/manage/devices/${auth.deviceId}`, { headers: parentHeaders, data: { name: '每日额度测试电视' } });
  await page.route('**/api/manage/watch-control', async route => {
    const data = await (await route.fetch()).json();
    await route.fulfill({ json: { ...data, devices: data.devices.map((device: { deviceId: string }) => device.deviceId === auth.deviceId ? { ...device, online: false } : device) } });
  });
  await page.goto('/manage/');
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '我的电视', exact: true }).click();
  const device = page.getByRole('region', { name: '每日额度测试电视观看安排' });
  await device.getByRole('button', { name: '观看设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await chooseSelect(dialog.getByLabel('每天看几集', { exact: true }), '2');
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(device.getByText('今日还能看 2 集', { exact: true })).toBeVisible();
  await expect(device.getByRole('status')).toHaveText('已安排 · 电视离线，开机联网后生效');
  await page.screenshot({ path: testInfo.outputPath('daily-quota-parent.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('daily-quota-parent-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${apiOrigin}/tv/`);
  await expect(page.getByLabel('今日观看额度')).toHaveText('今日剩余 2 集');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await openFolder(page);
  const playAndPause = async (id: string) => {
    await page.locator(`[data-focus="episode-${id}"]`).click();
    const video = page.getByRole('dialog', { name: '视频播放', exact: true }).locator(':scope > video');
    await expect.poll(() => video.evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await video.evaluate(v => (v as HTMLVideoElement).pause());
  };
  await playAndPause('browser-episode');
  await page.keyboard.press('Escape');
  const first = await read();
  expect(first.round.remainingEpisodes).toBe(1);
  await page.reload();
  await expect(page.getByLabel('今日观看额度')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await read()).round.id).toBe(first.round.id);
  await openFolder(page);
  await playAndPause('browser-episode');
  expect((await read()).round.remainingEpisodes).toBe(1);
  await page.keyboard.press('Escape');
  await playAndPause('browser-next');
  expect((await read()).round.remainingEpisodes).toBe(0);
  await page.keyboard.press('Escape');
  await page.locator('[data-focus="episode-browser-episode"]').click();
  await expect(page.getByRole('heading', { name: '今日观看', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '结束今日观看', exact: true }).click();
  await page.keyboard.type('0000');
  await expect(page.getByRole('alert').filter({ hasText: '家长密码不正确' })).toBeVisible();
  await page.keyboard.type('1234');
  await expect(page.getByRole('heading', { name: '看完啦，休息一下吧。', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('今日观看额度')).toHaveText('今日已结束');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('daily-quota-tv-home.png') });
  await openFolder(page);
  await page.locator('[data-focus="episode-browser-episode"]').click();
  await expect(page.getByRole('heading', { name: '今日观看已结束', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '加看 1 集', exact: true }).click();
  await page.keyboard.type('1234');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await read()).round.remainingEpisodes).toBe(1);
  expect((await read()).amount).toBe(2);
  expect(errors).toEqual([]);
});

test('time quota stops real playback, keeps progress, and parent adds ten minutes', async ({ page }) => {
  const { headers, read, command } = await setup(page);
  const state = await command('settings', { enabled: true, mode: 'minutes', amount: 1 });
  await page.request.post(`${apiOrigin}/api/watch-control/sync`, { headers, data: { roundId: state.round.id, playedMs: 59000 } });
  await page.goto(`${apiOrigin}/tv/`);
  await openFolder(page);
  await page.locator('[data-focus="episode-browser-episode"]').click();
  await expect(page.getByRole('dialog', { name: '视频播放', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '视频播放', exact: true })).toHaveCount(0, { timeout: 10000 });
  await expect.poll(async () => (await read()).status).toBe('resting');
  const progress = await (await page.request.get(`${apiOrigin}/api/episodes/browser-episode/progress`, { headers })).json();
  expect(progress.positionMs).toBeGreaterThan(0); expect(progress.completed).toBe(false);
  await page.reload();
  await expect(page.getByLabel('今日观看额度')).toHaveText('今日已结束');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await command('add');
  await expect(page.getByLabel('今日观看额度')).toHaveText('今日剩余 10 分钟');
  expect((await read()).round.remainingMs).toBe(600000);
});

for (const [mode, amount] of [['episodes', 1], ['episodes', 2], ['episodes', 3], ['minutes', 15], ['minutes', 30], ['minutes', 60]] as const) {
  test(`TV configures daily ${mode} ${amount} with one PIN and defers later changes`, async ({ page }, testInfo) => {
    const { read } = await setup(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${apiOrigin}/tv/`);
    await openControls(page);
    await expect(page.getByRole('group', { name: '观看数量' }).getByRole('button')).toHaveCount(6);
    const choice = page.getByRole('button', { name: `${amount} ${mode === 'episodes' ? '集' : '分钟'}`, exact: true });
    await expect(choice).toBeInViewport();
    await choice.focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '保存并开始观看', exact: true }).click();
    const before = await read();
    await page.keyboard.type('123');
    await expect(page.getByLabel('已输入 3 位密码')).toBeVisible();
    expect((await read()).version).toBe(before.version);
    if (amount === 60) await page.screenshot({ path: testInfo.outputPath('daily-quota-pin-720p.png') });
    await page.keyboard.type('4');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const started = await read();
    expect(started.mode).toBe(mode); expect(started.amount).toBe(amount); expect(started.status).toBe('allowed');
    await page.reload();
    await expect(page.getByLabel('今日观看额度')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await read()).round.id).toBe(started.round.id);
    await openControls(page);
    await page.getByRole('button', { name: '观看设置', exact: true }).click();
    await page.getByRole('button', { name: '30 分钟', exact: true }).click();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.keyboard.type('1234');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const updated = await read();
    expect(updated.amount).toBe(30); expect(updated.mode).toBe('minutes');
    expect(updated.round).toEqual(started.round);
  });
}

test('custom daily quantities are retained by TV and additions only affect today', async ({ page }) => {
  const { read, command } = await setup(page);
  await command('settings', { enabled: true, mode: 'minutes', amount: 25 });
  await page.goto(`${apiOrigin}/tv/`);
  await expect(page.getByLabel('今日观看额度')).toHaveText('今日剩余 25 分钟');
  await openControls(page);
  await page.getByRole('button', { name: '加看 10 分钟', exact: true }).click();
  await page.keyboard.type('1234');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await read()).amount).toBe(25);
  expect((await read()).round.remainingMs).toBe(35 * 60000);
});
