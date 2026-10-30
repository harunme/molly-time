import { test, expect, type Page } from '@playwright/test';

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

async function login(page: Page) {
  await page.goto('/manage/#/library/season');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} loads and operates on more than 200 videos without page boundaries`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const batches: number[] = [], uploadBatches: number[] = [], publicationBatches: number[] = [];
    let template: Record<string, unknown> | undefined;
    await page.route('**/api/manage/resources/publication', async route => {
      const body = route.request().postDataJSON();
      publicationBatches.push(body.ids.length);
      await route.fulfill({ json: { changed: body.ids.length, unchanged: 0, hidden: 0, skipped: [] } });
    });
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/api/manage/uploads' && url.searchParams.has('itemIds')) uploadBatches.push(url.searchParams.getAll('itemIds').length);
    });
    await page.route('**/api/manage/resources?**', async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('parentId') !== 'season') return route.continue();
      const response = await route.fetch();
      const original = await response.json();
      template ??= original.items[0];
      const items = Array.from({ length: 201 }, (_, index) => ({ ...template, id: `continuous-${index}`, name: `连续视频 ${index}`, type: 'Episode' }));
      const batch = Number(url.searchParams.get('page'));
      batches.push(batch);
      await route.fulfill({ json: { ...original, total: items.length, items: items.slice((batch - 1) * 100, batch * 100) } });
    });
    await login(page);
    await expect(page.locator(mobile ? '.m-content-item' : '.resource-tile')).toHaveCount(201);
    expect(batches).toEqual([1, 2, 3]);
    await expect(page.getByRole('navigation', { name: /资源库分页|手机内容分页/ })).toHaveCount(0);
    if (!mobile) {
      const body = page.locator('.folder-panel-body');
      await body.evaluate(node => { node.scrollTop = 800; });
      await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(800);
      await page.getByRole('button', { name: '返回英语启蒙', exact: true }).click();
      await page.getByRole('button', { name: '第 1 季', exact: true }).click();
      await expect(page.locator('.resource-tile')).toHaveCount(201);
      await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(800);
    }
    await page.getByRole('button', { name: mobile ? '选择' : '选择视频', exact: true }).click();
    await page.getByRole('button', { name: '全选当前列表', exact: true }).click();
    await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(201);
    await expect.poll(() => uploadBatches.length).toBeGreaterThanOrEqual(3);
    expect(uploadBatches.every(count => count <= 100)).toBe(true);
    await expect(page.getByRole('alert').filter({ hasText: '上传状态' })).toHaveCount(0);
    await page.getByRole('button', { name: '下架', exact: true }).click();
    await expect.poll(() => publicationBatches).toEqual([200, 1]);
    await expect(page.getByRole('status').filter({ hasText: '已下架 201 个视频' })).toBeVisible();
  });
}

test('a failed later batch cannot expose an incomplete directory as complete and can retry', async ({ page }) => {
  let fail = true;
  await page.route('**/api/manage/resources?**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('parentId') !== 'season') return route.continue();
    if (url.searchParams.get('page') === '2' && fail) return route.fulfill({ status: 503, json: { detail: '后续内容加载失败' } });
    const original = await (await route.fetch()).json();
    const items = Array.from({ length: 101 }, (_, index) => ({ ...original.items[0], id: `retry-${index}`, name: `重试视频 ${index}` }));
    const batch = Number(url.searchParams.get('page'));
    await route.fulfill({ json: { ...original, total: 101, items: items.slice((batch - 1) * 100, batch * 100) } });
  });
  await login(page);
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择视频', exact: true })).toHaveCount(0);
  await expect(page.locator('.resource-tile')).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.locator('.resource-tile')).toHaveCount(101);
  await expect(page.getByRole('button', { name: '选择视频', exact: true })).toBeEnabled();
});
