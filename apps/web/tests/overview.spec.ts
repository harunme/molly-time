import { test, expect } from '@playwright/test';

test('overview is the default home, uses aggregates and compact widgets, and links to management pages', async ({ page }) => {
  const errors: string[] = [];
  const requests: URL[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes('/api/manage/')) requests.push(new URL(request.url()));
  });
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  const response = page.waitForResponse((result) => new URL(result.url()).pathname === '/api/manage/overview' && result.ok());
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const data = await (await response).json();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: '播放控制', exact: true })).toHaveCount(0);
  const navigation = page.getByRole('navigation', { name: '管理导航', exact: true });
  await expect(navigation.getByRole('link', { name: '概览', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(navigation.getByRole('button', { name: '首页编排', exact: true })).toHaveCount(0);
  const metric = page.locator('.overview-metric').filter({ hasText: '在线设备' });
  await expect(metric.locator('.overview-metric-value')).toHaveText(`${data.devices.online} 台`);
  await expect(page.locator('.overview-metric').filter({ hasText: '今日观看时长' }).locator('.overview-metric-value')).toHaveText('0 分钟');
  await expect(page.locator('.overview-metric').filter({ hasText: '本周观看时长' }).locator('.overview-metric-value')).toHaveText('0 分钟');
  await expect(page.locator('.overview-metric').filter({ hasText: '本次观看时长' }).locator('.overview-metric-value')).toHaveText('0 分钟');
  await expect(page.locator('.overview-metric').filter({ hasText: '正在观看' }).locator('.overview-metric-value')).toHaveText('暂无正在观看');
  await expect(page.locator('.overview-most-played')).toContainText('暂无观看记录');
  await expect(page.locator('.overview-most-played').getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '观看热力图', exact: true })).toBeVisible();
  await expect(page.locator('.overview-heatmap-day')).toHaveCount(365);
  await expect(page.getByText('近一年还没有观看记录，电视播放后会在这里显示。')).toBeVisible();
  const latest = page.locator('.overview-heatmap-day').last();
  await latest.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.overview-heatmap-day').nth(357)).toBeFocused();
  await expect(page.locator('.overview-heatmap-footer p')).toContainText(data.watch.days[357].date);
  await page.keyboard.press('End');
  await expect(latest).toBeFocused();
  await expect(page.getByRole('navigation', { name: '概览上传分页', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '最近上传', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '电视设备', exact: true })).toHaveCount(0);
  const resources = page.locator('.overview-resources');
  for (const [label, key] of [['动画片', 'series'], ['已发布视频', 'episodes'], ['字幕', 'subtitles']]) {
    await expect(resources.locator('dl > div').filter({ hasText: label }).locator('strong')).toHaveText(String(data.resources[key]));
  }
  expect(requests.some((url) => ['/api/manage/uploads', '/api/manage/devices', '/api/manage/resources'].includes(url.pathname))).toBeFalsy();
  await page.screenshot({ path: '../../artifacts/manage-overview-desktop.png', fullPage: true, animations: 'disabled' });
  await expect(page.getByRole('button', { name: '管理资源', exact: true })).toHaveCount(0);
  await navigation.getByRole('link', { name: '资源库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  await navigation.getByRole('link', { name: '概览', exact: true }).click();
  await page.getByRole('button', { name: '查看本周观看时长', exact: true }).click();
  await expect(page.getByRole('heading', { name: '观看记录', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '播放控制', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: '观看记录', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: '观看记录', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  await page.locator('.overview-resources').getByRole('button', { name: '资源库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  await navigation.getByRole('link', { name: '概览', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '管理资源', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: '../../artifacts/manage-overview-mobile.png', fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('overview shows watch durations, video play counts and heatmap intensity on desktop and mobile', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let playing = true;
  await page.route('**/api/manage/reminders/devices', (route) => route.fulfill({ json: [
    { id: 'living', name: '客厅电视', phase: 'idle', requestId: null, online: true, bootPlayedMs: 20 * 60000,
      currentWatch: playing ? { sessionId: 'current-1', name: 'Yum Yum', playedMs: 9 * 60000 } : null },
    { id: 'bedroom', name: '卧室电视', phase: 'idle', requestId: null, online: true, bootPlayedMs: 10 * 60000,
      currentWatch: playing ? { sessionId: 'current-2', name: '一起认识世界和新的朋友：茉莉的英语启蒙故事', playedMs: 3 * 60000 } : null },
  ] }));
  await page.route('**/api/manage/overview', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const levels = [0, 5, 15, 30, 60];
    const days = data.watch.days.map((day: { date: string; playedMs: number }, index: number) => ({
      ...day, playedMs: index >= 360 ? levels[index - 360] * 60000 : index % 3 === 0 ? 20 * 60000 : 0,
    }));
    await route.fulfill({ json: {
      ...data, devices: { ...data.devices, online: 2, active: 3 },
      watch: { ...data.watch, days, todayPlayedMs: 75 * 60000, weekPlayedMs: 485 * 60000,
        mostPlayedVideos: [{ id: 'episode', name: '茉莉最喜欢看的英语启蒙故事：一起认识世界和新的朋友', playCount: 12 }, { id: 'second', name: 'Yum Yum', playCount: 6 }] },
    } });
  });
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.overview-metric').filter({ hasText: '在线设备' }).locator('.overview-metric-value')).toHaveText('2 台');
  await expect(page.locator('.overview-metric').filter({ hasText: '今日观看时长' }).locator('.overview-metric-value')).toHaveText('1 小时 15 分钟');
  await expect(page.locator('.overview-metric').filter({ hasText: '本周观看时长' }).locator('.overview-metric-value')).toHaveText('8 小时 5 分钟');
  await expect(page.locator('.overview-ranking')).toHaveAttribute('aria-label', /一起认识世界和新的朋友：12 次.*Yum Yum：6 次/);
  await expect(page.locator('.overview-most-played').getByRole('button')).toHaveCount(0);
  const bars = page.locator('.overview-ranking .watch-history-stack');
  const heights = await bars.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(heights[0]).toBeCloseTo(heights[1] * 2, 0);
  const currentDuration = page.locator('.overview-metric').filter({ hasText: '本次观看时长' });
  const currentVideo = page.locator('.overview-metric').filter({ hasText: '正在观看' });
  await expect(currentDuration.locator('.overview-metric-value')).toHaveText('30 分钟');
  await expect(currentVideo.getByRole('button')).toHaveCount(0);
  await expect(currentDuration.getByRole('button')).toHaveCount(0);
  await currentVideo.locator('.overview-metric-value').click();
  await expect(page.getByRole('dialog', { name: '观看记录', exact: true })).toHaveCount(0);
  await expect(currentVideo.locator('.overview-metric-value')).toContainText('Yum Yum');
  await expect(currentVideo).toContainText('客厅电视 · Yum Yum');
  const cells = page.locator('.overview-heatmap-day');
  for (let level = 0; level < 5; level++) await expect(cells.nth(360 + level)).toHaveAttribute('data-level', String(level));
  await cells.nth(363).focus();
  await expect(page.locator('.overview-heatmap-footer p')).toContainText('观看 30 分钟');
  await page.screenshot({ path: testInfo.outputPath('overview-watch-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await expect(page.locator('.overview-ranking')).toBeVisible();
  await expect.poll(() => page.locator('.overview-heatmap-scroll').evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await page.locator('.overview-heatmap').scrollIntoViewIfNeeded();
  await expect(cells.last()).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('overview-watch-mobile.png'), fullPage: true, animations: 'disabled' });
  playing = false;
  await expect(currentVideo.locator('.overview-metric-value')).toHaveText('暂无正在观看', { timeout: 10000 });
  await expect(currentDuration.locator('.overview-metric-value')).toHaveText('30 分钟');
  expect(errors).toEqual([]);
});

test('overview keeps loading inside widgets and clears it after success or failure', async ({ page }) => {
  let releaseOverview!: () => void;
  const pending = new Promise<void>((resolve) => { releaseOverview = resolve; });
  await page.route('**/api/manage/overview', async (route) => {
    await pending;
    await route.continue();
  });
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const metrics = page.locator('.overview-metrics');
  const heatmap = page.locator('.overview-heatmap');
  await expect(metrics).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status').filter({ hasText: '正在加载概览' })).toHaveClass('sr-only');
  await expect(page.locator('.overview-metric').filter({ hasText: '今日观看时长' }).locator('.overview-metric-skeleton')).toBeVisible();
  await expect(heatmap.locator('.overview-heatmap-skeleton')).toBeVisible();
  await expect(heatmap.getByRole('button', { name: '查看明细' })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  releaseOverview();
  await expect(metrics).toHaveAttribute('aria-busy', 'false');
  await expect(heatmap.locator('.overview-heatmap-skeleton')).toHaveCount(0);
  await expect(heatmap.getByRole('button', { name: '查看明细' })).toBeEnabled();
  await expect(page.locator('.overview-heatmap-day')).toHaveCount(365);

  await page.unroute('**/api/manage/overview');
  await page.route('**/api/manage/overview', (route) => route.fulfill({ status: 503, json: { detail: '概览服务暂时不可用' } }));
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: '概览服务暂时不可用' })).toBeVisible();
  await expect(metrics).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.overview-skeleton')).toHaveCount(0);
  await expect(heatmap).toContainText('观看热力图加载失败');
});
