import { chooseSelect } from "./select";
import { test, expect } from '@playwright/test';

test('family viewing loads when reports are reopened and does not belong to a child', async ({ page }) => {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  const firstReport = page.waitForResponse((r) => r.url().includes('/reports/watch-time?') && r.ok());
  await page.getByRole('navigation').getByRole('link', { name: '观看记录' }).click();
  const baseline = await (await firstReport).json();
  await expect(page.getByText('加载中…', { exact: true })).toHaveCount(0);
  const familyRows = page.getByRole('cell', { name: '家庭观看', exact: false });
  const initialFamilyRows = await familyRows.count();
  const authResponse = await page.request.post('/api/auth/login', {
    headers: { 'X-Molly-Client': 'tv-shell/2' },
    data: { username: 'parent@example.test', password: 'parent-e2e' },
  });
  const auth = await authResponse.json();
  const headers = { Authorization: `Bearer ${auth.accessToken}` };
  const started = await page.request.post('/api/playback/sessions', {
    headers, data: { episodeId: 'episode' },
  });
  expect(started.ok()).toBe(true);
  const session = await started.json();
  const synced = await page.request.post(`/api/playback/sessions/${session.sessionId}/events`, {
    headers, data: { seq: 0, startMs: 0, endMs: 1000, playedMs: 1000, positionMs: 1000 },
  });
  expect(synced.ok()).toBe(true);
  await expect(familyRows).toHaveCount(initialFamilyRows);
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '概览', exact: true }).click();
  const updatedReport = page.waitForResponse((r) => r.url().includes('/reports/watch-time?') && r.ok());
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '观看记录', exact: true }).click();
  const updated = await (await updatedReport).json();
  expect(updated.totalPlayedMs).toBe(baseline.totalPlayedMs + 1000);
  expect(updated.sessions.find((s: { id: string }) => s.id === session.sessionId).childName).toBe('家庭观看');
  await expect(familyRows).toHaveCount(initialFamilyRows + 1);
  const childReport = page.waitForResponse((r) => r.url().includes('/reports/watch-time?') && r.url().includes('childId=child') && r.ok());
  await chooseSelect(page.getByRole('combobox', { name: '儿童', exact: true }), 'child');
  expect((await (await childReport).json()).sessions.some((s: { id: string }) => s.id === session.sessionId)).toBe(false);
  await expect(familyRows).toHaveCount(0);
  await chooseSelect(page.getByRole('combobox', { name: '儿童', exact: true }), '');
  await expect(familyRows).toHaveCount(initialFamilyRows + 1);
});
