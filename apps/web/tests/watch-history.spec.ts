import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '观看热力图', exact: true })).toBeVisible();
}

for (const width of [390, 1440]) {
  test(`heatmap opens a compact dated report and restores focus at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/api/manage/reports/watch-time?*', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ json: { ...data, totalPlayedMs: 485 * 60000, episodeCount: 3,
        statisticsSince: '2026-10-01T04:00:00Z', lastSync: '2026-10-13T04:00:00Z',
        days: data.days.map((day: { date: string }, i: number) => ({ ...day, playedMs: (i % 5 + 1) * 60000 })),
        contents: [{ id: 'series', name: '一起认识世界和新的朋友：英语启蒙故事', playedMs: 485 * 60000 }], contentTotal: 1,
        sessions: [{ id: 'session', name: '一起认识世界和新的朋友：英语启蒙故事', deviceName: '客厅电视', startedAt: '2026-10-13T04:00:00Z', playedMs: 75 * 60000, ended: true }], sessionTotal: 1,
      } });
    });
    await page.route('**/api/manage/overview', async (route) => {
      const data = await (await route.fetch()).json();
      await route.fulfill({ json: { ...data, watch: { ...data.watch, todayPlayedMs: 75 * 60000,
        days: data.watch.days.map((day: { date: string }, i: number) => ({ ...day, playedMs: i > 333 ? (i % 7 === 0 ? 90 : i % 3 === 0 ? 20 : 0) * 60000 : 0 })) } } });
    });
    await login(page);
    await expect(page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '观看记录' })).toHaveCount(0);
    const latest = page.locator('.overview-heatmap-day').last();
    const date = (await latest.getAttribute('aria-label'))!.slice(0, 10);
    const request = page.waitForRequest((request) => request.url().includes('/reports/watch-time?'));
    await latest.click();
    const url = new URL((await request).url());
    expect(url.searchParams.get('start')).toBe(date);
    expect(url.searchParams.get('end')).toBe(date);
    const dialog = page.getByRole('dialog', { name: '观看记录', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.watch-history-stats')).toContainText('1 小时 15 分钟');
    await expect(dialog.getByRole('button', { name: '开始日期' })).toHaveCount(0);
    await expect(dialog.getByText('客厅电视', { exact: true })).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`watch-dialog-${width}.png`), animations: 'disabled' });
    await dialog.getByText('内容分布', { exact: true }).click();
    await expect(dialog.getByText('一起认识世界和新的朋友：英语启蒙故事', { exact: true })).toHaveCount(2);
    await dialog.getByRole('button', { name: '全部记录', exact: true }).click();
    await expect(dialog.locator('.watch-history-bars button')).toHaveCount(31);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(latest).toBeFocused();
    await expect(page).toHaveURL(/#\/overview$/);
    await page.getByRole('button', { name: '查看明细', exact: true }).click();
    await expect(dialog.locator('.watch-history-bars button')).toHaveCount(31);
    await page.screenshot({ path: testInfo.outputPath(`watch-panel-${width}.png`), animations: 'disabled' });
    await page.reload();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: '查看明细', exact: true })).toBeFocused();
  });
}

test('legacy watch URL redirects and failed reports can be retried', async ({ page }) => {
  await login(page);
  let fail = true;
  await page.route('**/api/manage/reports/watch-time?*', async (route) => {
    if (fail) await route.fulfill({ status: 503, json: { detail: '暂时无法读取观看记录' } });
    else await route.continue();
  });
  await page.goto('/manage/#/watch');
  const dialog = page.getByRole('dialog', { name: '观看记录', exact: true });
  await expect(page).toHaveURL(/overview\?watch=1$/);
  await expect(dialog.getByRole('alert')).toContainText('暂时无法读取观看记录');
  fail = false;
  await dialog.getByRole('button', { name: '重试' }).click();
  await expect(dialog.locator('.watch-history-stats')).toBeVisible();
});
