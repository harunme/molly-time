import { test, expect, type Page } from '@playwright/test';

async function expectToast(page: Page, message: string) {
  // Sonner schedules its mount on the next frame after the polling response.
  await expect.poll(async () => {
    await page.clock.runFor(100);
    return page.getByText(message, { exact: true }).isVisible();
  }).toBe(true);
}

test('boot alerts work across management pages, avoid login and polling duplicates, and support browser permission', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { notifications: string[]; permissionRequests: number; Notification: unknown };
    w.notifications = []; w.permissionRequests = 0;
    w.Notification = class {
      static permission = 'default';
      static async requestPermission() { w.permissionRequests++; this.permission = 'granted'; return 'granted'; }
      constructor(title: string) { w.notifications.push(title); }
      close() {}
    };
  });
  const device = { id: 'living', name: '客厅电视', phase: 'idle', requestId: null,
    online: true, bootId: 'android:5', bootPlayedMs: 0 };
  await page.route('**/api/manage/reminders/devices', (route) => route.fulfill({ json: [device] }));
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.overview-online .overview-metric-value')).toHaveText('1 台');
  await expect(page.getByText('客厅电视已开机', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '开启开机通知', exact: true }).click();
  await expect(page.getByRole('button', { name: '开机通知已开启', exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as unknown as { permissionRequests: number }).permissionRequests)).toBe(1);
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '资源库', exact: true }).click();
  await page.clock.install();
  device.bootId = 'android:6';
  await page.clock.fastForward(5000);
  await expectToast(page, '客厅电视已开机');
  const notifications = () => page.evaluate(() => (window as unknown as { notifications: string[] }).notifications);
  await expect.poll(notifications).toEqual(['客厅电视已开机']);
  await page.clock.fastForward(5000);
  expect(await notifications()).toEqual(['客厅电视已开机']);

});

for (const reboot of [true, false]) test(`denied notifications still show ${reboot ? 'boot' : 'reconnection'} page alerts`, async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Notification', { value: class {
      static permission = 'denied';
      static requestPermission() { throw new Error('Must be a user action'); }
      constructor() { throw new Error('Permission denied'); }
    } });
  });
  const device = { id: 'living', name: '客厅电视', phase: 'idle', requestId: null,
    online: false, bootId: 'android:5', bootPlayedMs: 0 };
  await page.route('**/api/manage/reminders/devices', (route) => route.fulfill({ json: [device] }));
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.overview-online .overview-metric-value')).toHaveText('0 台');
  await page.clock.install();
  device.online = true;
  if (reboot) device.bootId = 'android:6';
  await page.clock.fastForward(5000);
  await expectToast(page, reboot ? '客厅电视已开机' : '客厅电视已上线');
});
