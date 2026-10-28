import { test, expect, type Page } from '@playwright/test';

type Device = { id: string; name: string; online: boolean; phase: string; requestId: string | null; currentWatch?: { sessionId: string; name: string; playedMs: number } | null; watchManagement?: boolean };
const television = (id: string, name: string, online = true): Device => ({ id, name, online, phase: 'idle', requestId: null, currentWatch: online ? { sessionId: `session-${id}`, name: '当前视频', playedMs: 1000 } : null });

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

test('no online TVs hides the session reminder', async ({ page }) => {
  const offline = { ...television('offline', '离线电视', false), requestId: 'existing', phase: 'done' };
  const result = await controls(page, [offline]);
  await expect(page.getByRole('group', { name: '播放控制', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '恢复播放', exact: true })).toHaveCount(0);
  expect(result.sent).toEqual([]);
});

test('a managed TV can receive one reminder and needs no manual restore', async ({ page }) => {
  const result = await controls(page, [{ ...television('living', '客厅电视'), watchManagement: true }]);
  const button = page.getByRole('button', { name: '这集看完休息', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  expect(result.sent).toEqual([{ deviceId: 'living' }]);
  await expect(button).toBeDisabled();
  await expect(page.getByRole('button', { name: '恢复播放', exact: true })).toHaveCount(0);
  await page.clock.install();
  const device = result.state.devices[0];
  device.phase = 'idle'; device.requestId = null;
  device.currentWatch = { sessionId: 'next-session', name: '新的视频', playedMs: 0 };
  await page.clock.fastForward(5000);
  await expect(button).toBeEnabled();
  expect(result.restored).toEqual([]);
});

test('only current playback can be reminded and offline TVs are excluded', async ({ page }) => {
  const idle = { ...television('idle', '待机电视'), currentWatch: null };
  const result = await controls(page, [television('living', '客厅电视'), television('bedroom', '卧室电视'), idle, television('offline', '离线电视', false)]);
  await page.getByRole('button', { name: '这集看完休息', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择要提醒的电视', exact: true });
  await expect(picker.getByRole('button', { name: '提醒：离线电视' })).toHaveCount(0);
  await expect(picker.getByRole('button', { name: '提醒：待机电视', exact: true })).toBeDisabled();
  await picker.getByRole('button', { name: '提醒：卧室电视', exact: true }).click();
  expect(result.sent).toEqual([{ deviceId: 'bedroom' }]);
  await page.getByRole('button', { name: '这集看完休息', exact: true }).click();
  await expect(picker.getByRole('button', { name: '提醒：卧室电视', exact: true })).toBeDisabled();
  await page.clock.install();
  result.state.devices.forEach(device => { device.online = false; });
  await page.clock.fastForward(5000);
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole('group', { name: '播放控制', exact: true })).toHaveCount(0);
});
