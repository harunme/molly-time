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
      const query = new URL(route.request().url()).searchParams;
      const totalPlayedMs = (query.get("start") === query.get("end") ? 75 : 485) * 60000;
      await route.fulfill({ json: { ...data, totalPlayedMs, episodeCount: 3,
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
    await dialog.getByText('播放明细', { exact: true }).click();
    await expect(dialog.getByText('客厅电视', { exact: true })).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`watch-dialog-${width}.png`), animations: 'disabled' });
    await dialog.getByText('内容分布', { exact: true }).click();
    await expect(dialog.getByText('一起认识世界和新的朋友：英语启蒙故事', { exact: true })).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(latest).toBeFocused();
    await expect(page).toHaveURL(/#\/overview$/);
    await page.getByRole('button', { name: '查看明细', exact: true }).click();
    await expect(dialog.locator('.watch-history-bars > div')).toHaveCount(31);
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

for (const width of [390, 1440]) {
  test(`device stacks filter records and reset pagination at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/manage/reports/watch-time?*', async (route) => {
      const data = await (await route.fetch()).json();
      const params = new URL(route.request().url()).searchParams;
      const selected = params.get('deviceId');
      const deviceName = selected === 'bedroom' ? '卧室电视' : '客厅电视';
      const allParts = [{ deviceId: 'living-room', playedMs: 120000 }, { deviceId: 'bedroom', playedMs: 60000 }];
      const parts = selected ? allParts.filter((part) => part.deviceId === selected) : allParts;
      const playedMs = parts.reduce((sum, part) => sum + part.playedMs, 0);
      await route.fulfill({ json: { ...data,
        devices: [{ id: 'living-room', name: '客厅电视' }, { id: 'bedroom', name: '卧室电视' }],
        days: data.days.map((day: { date: string }) => ({ ...day, playedMs, devices: parts })),
        hours: data.hours.map((hour: { hour: number }) => ({ ...hour, playedMs: hour.hour === 8 ? playedMs : 0, devices: hour.hour === 8 ? parts : [] })),
        totalPlayedMs: data.days.length * playedMs, episodeCount: 1,
        sessions: [{ id: `session-${selected ?? 'all'}`, name: `${selected ?? 'all'}的节目`, deviceName, startedAt: '2026-10-10T00:00:00Z', playedMs, ended: true }],
        sessionTotal: 2, pageSize: 1,
        contents: [{ id: selected ?? 'all', name: `${selected ?? 'all'}的内容`, playedMs }], contentTotal: 1,
      } });
    });
    await login(page);
    await page.getByRole('button', { name: '查看明细', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '观看记录', exact: true });
    const bars = dialog.locator('.watch-history-bars > div');
    await expect(bars).toHaveCount(31);
    const segments = bars.first().locator('.watch-history-stack > button');
    await expect(segments).toHaveCount(2);
    await segments.first().focus();
    await expect(dialog.locator('.watch-history-chart-detail')).toContainText('客厅电视 2 分钟 · 卧室电视 1 分钟');
    const colors = await segments.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
    expect(colors[0]).not.toBe(colors[1]);
    const date = (await bars.first().getAttribute('aria-label'))!.slice(0, 10);
    const request = page.waitForRequest((request) => request.url().includes('/reports/watch-time?') && new URL(request.url()).searchParams.get('deviceId') === 'living-room');
    await segments.first().click();
    const selectedParams = new URL((await request).url()).searchParams;
    expect(selectedParams.get('start')).toBe(date);
    expect(selectedParams.get('end')).toBe(date);
    await expect(dialog.locator('.watch-history-scope')).toContainText('客厅电视');
    await expect(dialog.locator('.watch-history-list').first()).toContainText('living-room的节目');
    await expect(dialog.locator('.watch-history-stats')).toContainText('2 分钟');
    const hours = dialog.locator('.watch-history-hourly-bars > div');
    await expect(hours).toHaveCount(24);
    expect(await hours.nth(8).locator('.watch-history-stack > button').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor))).toEqual(colors);
    await dialog.getByRole('navigation', { name: '播放明细分页' }).getByRole('button', { name: '播放明细分页：下一页', exact: true }).click();
    await expect(dialog.getByRole('navigation', { name: '播放明细分页' })).toContainText('2');
    const switchRequest = page.waitForRequest((request) => request.url().includes('/reports/watch-time?') && new URL(request.url()).searchParams.get('deviceId') === 'bedroom');
    await hours.nth(8).getByRole('button', { name: '卧室电视 · 1 分钟，查看该设备记录', exact: true }).click();
    expect(new URL((await switchRequest).url()).searchParams.get('sessionPage')).toBe('1');
    await expect(dialog.locator('.watch-history-scope')).toContainText('卧室电视');
    await expect(dialog.locator('.watch-history-list').first()).toContainText('bedroom的节目');
    await expect(dialog.locator('.watch-history-list').first()).not.toContainText('living-room的节目');
    await dialog.getByText('内容分布', { exact: true }).click();
    await expect(dialog.locator('.watch-history-list').last()).toContainText('bedroom的内容');
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`device-filter-${width}.png`) });
    await dialog.getByRole('button', { name: '全部设备', exact: true }).click();
    await expect(dialog.locator('.watch-history-list').first()).toContainText('all的节目');
    await expect(dialog.locator('.watch-history-scope')).not.toContainText('卧室电视');
    await expect(dialog.getByRole('button', { name: '全部设备', exact: true })).toHaveCount(0);
  });
}
