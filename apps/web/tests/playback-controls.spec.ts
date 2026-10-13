import { test, expect, type Page } from '@playwright/test';

type Device = { id: string; name: string; online: boolean; phase: string; requestId: string | null };
const television = (id: string, name: string, online = true): Device => ({ id, name, online, phase: 'idle', requestId: null });

async function controls(page: Page, devices: Device[]) {
  const sent: { deviceId: string }[] = [], restored: string[] = [];
  const state = { devices, clipsReady: true };
  await page.route('**/api/manage/reminders', (route) => route.fulfill({ json: {
    enabled: true, warning: { ready: state.clipsReady }, farewell: { ready: state.clipsReady },
  } }));
  await page.route('**/api/manage/reminders/devices', (route) => route.fulfill({ json: state.devices }));
  await page.route('**/api/manage/reminders/requests', async (route) => {
    const body = route.request().postDataJSON();
    sent.push(body);
    const device = state.devices.find((row) => row.id === body.deviceId)!;
    device.requestId = 'request'; device.phase = 'pending';
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/manage/reminders/devices/*', async (route) => {
    const id = route.request().url().split('/').pop()!;
    restored.push(id);
    const device = state.devices.find((row) => row.id === id)!;
    device.requestId = null; device.phase = 'idle';
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  await expect(page.locator('.overview-metric').filter({ hasText: '在线设备' }).locator('.overview-metric-value')).toHaveText(`${devices.filter((device) => device.online).length} 台`);
  return { state, sent, restored };
}

test('no online TVs hides playback controls, including offline TVs with existing reminders', async ({ page }) => {
  const offline = { ...television('offline', '离线电视', false), requestId: 'existing', phase: 'done' };
  const result = await controls(page, [offline]);
  await expect(page.getByRole('group', { name: '播放控制', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发起提醒', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '恢复播放', exact: true })).toHaveCount(0);
  expect(result.sent).toEqual([]);
});

test('one online TV is controlled directly inside its metric card', async ({ page }, testInfo) => {
  const result = await controls(page, [television('living', '客厅电视'), television('offline', '卧室电视', false)]);
  const card = page.locator('.overview-metric').filter({ hasText: '在线设备' });
  await expect(card.getByRole('group', { name: '播放控制', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await card.getByRole('button', { name: '发起提醒', exact: true }).click();
  await expect(card.getByRole('button', { name: '恢复播放', exact: true })).toBeEnabled();
  expect(result.sent).toEqual([{ deviceId: 'living' }]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card.getByRole('button', { name: '发起提醒', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('online-device-controls.png'), fullPage: true });
  await card.getByRole('button', { name: '恢复播放', exact: true }).click();
  await expect(card.getByRole('button', { name: '发起提醒', exact: true })).toBeEnabled();
  expect(result.restored).toEqual(['living']);
});

test('multiple online TVs are chosen only after clicking an action', async ({ page }, testInfo) => {
  const result = await controls(page, [television('living', '客厅电视'), television('bedroom', '卧室电视'), television('offline', '离线电视', false)]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.getByRole('button', { name: '发起提醒', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择要提醒的电视', exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: '提醒：离线电视' })).toHaveCount(0);
  expect(result.sent).toEqual([]);
  await picker.getByRole('button', { name: '取消', exact: true }).click();
  expect(result.sent).toEqual([]);
  await page.getByRole('button', { name: '发起提醒', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('choose-reminder-device.png') });
  await picker.getByRole('button', { name: '提醒：卧室电视', exact: true }).click();
  await expect(picker).toHaveCount(0);
  expect(result.sent).toEqual([{ deviceId: 'bedroom' }]);
  await page.getByRole('button', { name: '发起提醒', exact: true }).click();
  await expect(picker.getByRole('button', { name: '提醒：卧室电视', exact: true })).toBeDisabled();
  await picker.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '恢复播放', exact: true }).click();
  const restore = page.getByRole('dialog', { name: '选择要恢复播放的电视', exact: true });
  await expect(restore.getByRole('button', { name: '恢复播放：客厅电视', exact: true })).toBeDisabled();
  await restore.getByRole('button', { name: '恢复播放：卧室电视', exact: true }).click();
  await expect(restore).toHaveCount(0);
  expect(result.restored).toEqual(['bedroom']);
  await page.getByRole('button', { name: '发起提醒', exact: true }).click();
  await page.clock.install();
  result.state.devices.forEach((device) => { device.online = false; });
  await page.clock.fastForward(5000);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('group', { name: '播放控制', exact: true })).toHaveCount(0);
  await expect(page.locator('.overview-metric').filter({ hasText: '在线设备' }).locator('.overview-metric-value')).toHaveText('0 台');
  expect(result.sent).toEqual([{ deviceId: 'bedroom' }]);
});
