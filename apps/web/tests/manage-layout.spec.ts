import { expect, test } from '@playwright/test';

for (const width of [390, 1280, 1920]) {
  test(`management pages use available width and stay readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/manage/');
    await page.getByLabel('账号', { exact: true }).fill('operator@example.test');
    await page.getByLabel('密码', { exact: true }).fill('operator-e2e');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
    const checkLayout = async (name: string) => {
      await expect(page.getByText(/^正在加载/)).toHaveCount(0);
      await expect(page.getByRole('button', { name: /刷新/ })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const main = await page.locator('.manage-main').boundingBox();
      const content = await page.locator('.page-content').boundingBox();
      expect(content!.width).toBeCloseTo(main!.width, 0);
      for (const heading of await page.locator('.page-content h2').all()) {
        await expect(heading).toHaveCSS('font-size', '18px');
      }
      await expect(page.locator('.page-title h1')).toBeInViewport();
      await page.screenshot({ path: `../../artifacts/design-audit/${name}-${width}.png`, fullPage: true, animations: 'disabled' });
    };
    for (const [route, name] of [['overview', '概览'], ['watch', '观看记录'], ['library', '资源库'], ['family', '家庭设置'], ['operations', '运营设置']]) {
      await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name, exact: true }).click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      await checkLayout(route);
      if (route === 'library') {
        await page.getByRole('button', { name: '上传任务', exact: true }).click();
        const tasks = page.getByRole('dialog', { name: '上传任务', exact: true });
        await expect(tasks).toBeVisible();
        const box = await tasks.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: `../../artifacts/design-audit/upload-dialog-${width}.png`, fullPage: true, animations: 'disabled' });
        await tasks.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(tasks).not.toBeVisible();
      }
      if (route === 'overview') {
        const cell = await page.locator('.overview-heatmap-day').last().boundingBox();
        expect(cell!.width).toBeCloseTo(cell!.height, 1);
        expect(cell!.width).toBe(12);
        expect((await page.locator('.overview-heatmap').boundingBox())!.height).toBeLessThan(width < 1440 ? 380 : 300);
        if (width >= 1280) {
          expect(await page.locator('.overview-heatmap-scroll').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        }
      }
      if (route === 'operations') {
        const content = await page.locator('.page-content').evaluate((element) => element.clientWidth - parseFloat(getComputedStyle(element).paddingLeft) - parseFloat(getComputedStyle(element).paddingRight));
        expect((await page.locator('.operations-card').boundingBox())!.width).toBeCloseTo(content, 0);
        for (const [tab, title] of [['家庭用量', '家庭用量'], ['用户邀请', '邀请码'], ['客户端版本', '客户端版本']]) {
          const trigger = page.getByRole('tab', { name: tab, exact: true });
          await trigger.click();
          await expect(trigger).toHaveAttribute('aria-selected', 'true');
          await expect(page.locator('[data-slot="tabs-content"][data-state="active"]').getByRole('heading', { name: title, exact: true })).toBeVisible();
          await checkLayout(`operations-${tab}`);
          if (tab === '用户邀请' && width === 390 && await page.locator('.invitations-table tbody tr').count()) {
            const dateLines = await page.locator('.invitations-table tbody tr').first().locator('td').nth(1).evaluate((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              return range.getClientRects().length;
            });
            expect(dateLines).toBe(1);
          }
        }
      }
    }
    expect(errors).toEqual([]);
  });
}

test('long durations stay on one line and fields share the same typography', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/manage/overview', async (route) => {
    const data = await (await route.fetch()).json();
    await route.fulfill({ json: { ...data, watch: { ...data.watch, todayPlayedMs: 75 * 60000, weekPlayedMs: 485 * 60000,
      favoriteVideo: { id: 'long-name', name: '一起认识世界和新的朋友：茉莉最喜欢看的英语启蒙故事', playedMs: 1200 * 60000 } } } });
  });
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const duration = page.locator('.overview-metric').filter({ hasText: '今日观看时长' }).locator('.overview-metric-value');
  await expect(duration).toHaveText('1 小时 15 分钟');
  const size = await duration.evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth, height: element.clientHeight }));
  expect(size.content).toBeLessThanOrEqual(size.width);
  expect(size.height).toBe(36);
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '家庭设置', exact: true }).click();
  for (const field of [page.getByLabel('儿童名称'), page.getByLabel('默认字幕', { exact: true }), page.getByLabel('用量月份')]) {
    await expect(field).toHaveCSS('font-size', '16px');
    await expect(field).toHaveCSS('height', '40px');
  }
});

test('populated watch reports keep durations and dates readable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/manage/reports/watch-time?*', async (route) => {
    const data = await (await route.fetch()).json();
    await route.fulfill({ json: { ...data, totalPlayedMs: 485 * 60000, episodeCount: 1,
      days: data.days.map((day: { date: string }, index: number) => ({ ...day, playedMs: index === data.days.length - 1 ? 485 * 60000 : 0 })),
      lastSync: '2026-10-13T04:00:00Z', statisticsSince: '2026-10-12T04:00:00Z',
      contents: [{ id: 'episode', name: '一起认识世界和新的朋友：英语启蒙故事', playedMs: 485 * 60000 }], contentTotal: 1,
      sessions: [{ id: 'session', startedAt: '2026-10-13T04:00:00Z', childName: '茉莉', deviceName: '客厅电视', name: '一起认识世界和新的朋友：英语启蒙故事', playedMs: 75 * 60000, ended: true }], sessionTotal: 1,
    } });
  });
  await page.goto('/manage/#/watch');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '播放明细', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const duration = page.locator('.watch-summary > div').first().locator('strong');
  const size = await duration.evaluate((element) => ({ width: element.parentElement!.clientWidth, content: element.scrollWidth }));
  expect(size.content).toBeLessThanOrEqual(size.width);
  await page.screenshot({ path: '../../artifacts/design-audit/watch-populated-390.png', fullPage: true, animations: 'disabled' });
});
