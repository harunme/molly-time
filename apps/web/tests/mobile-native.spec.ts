import { test, expect, devices, type Page } from '@playwright/test';
test.use({ ...devices['Pixel 7'], defaultBrowserType: 'chromium' });
async function login(page: Page, account = 'parent') {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill(`${account}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill(`${account}-e2e`);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
}
async function playing(page: Page) {
  await page.route('**/api/manage/reminders/devices', route => route.fulfill({ json: [{ id: 'living', name: '客厅电视', online: true, phase: 'idle', requestId: null, bootPlayedMs: 20 * 60000, currentWatch: { sessionId: 'now', name: '小猪佩奇 · 一起去野餐', playedMs: 12 * 60000 } }] }));
  await page.route('**/api/manage/overview', async route => {
    const data = await (await route.fetch()).json();
    await route.fulfill({ json: { ...data, watch: { ...data.watch, todayPlayedMs: 35 * 60000, weekPlayedMs: 145 * 60000, days: data.watch.days.map((day: { date: string }, i: number, all: unknown[]) => ({ ...day, playedMs: i > all.length - 7 ? [12, 26, 18, 35, 9, 28, 35][i % 7] * 60000 : 0 })) } } });
  });
}
test('mobile mounts its own app, home, family, devices and settings independently of desktop', async ({ page }) => {
  await playing(page); await login(page, 'operator');
  await expect(page.locator('.workspace')).toHaveCount(0);
  await expect(page.locator('.m-playing')).toContainText('一起去野餐');
  await expect(page.locator('.m-week > div')).toHaveCount(7);
  await expect(page.getByRole('navigation', { name: '手机导航' }).getByRole('link')).toHaveCount(4);
  await page.screenshot({ path: '../../artifacts/mobile-native/today.png', fullPage: true });
  for (const width of [320, 390, 768]) { await page.setViewportSize({ width, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('navigation', { name: '手机导航' }).getByRole('link', { name: '电视', exact: true }).click();
  await expect(page.getByRole('heading', { name: '客厅电视', exact: true })).toBeVisible();
  await page.screenshot({ path: '../../artifacts/mobile-native/devices.png', fullPage: true });
  await page.getByRole('link', { name: /播放与提醒/ }).click();
  await expect(page.getByLabel('默认字幕', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '手机导航' }).getByRole('link', { name: '家庭', exact: true }).click();
  await expect(page.getByRole('link', { name: '运营管理', exact: true })).toBeVisible();
  await page.screenshot({ path: '../../artifacts/mobile-native/family.png', fullPage: true });
  await page.getByRole('link', { name: /家庭与账号/ }).click();
  await expect(page.getByLabel('家庭名称', { exact: true })).toBeVisible();
});
test('content has search, native grid and list, route navigation and preserved scroll', async ({ page }) => {
  const folders = Array.from({ length: 20 }, (_, i) => ({ id: `native-${i}`, name: ['小猪佩奇', '古力小超人', '小鼠波波', '森林里的故事'][i % 4] + ` ${i + 1}`, type: 'Series', parentId: null, ancestors: [], status: 'published', ready: true, files: [], imageUrl: '', runtimeMs: 0 }));
  await page.route('**/api/manage/resources?*', route => { const query = new URL(route.request().url()).searchParams; const data = query.has('parentId') ? [] : folders.filter(item => !query.get('q') || item.name.includes(query.get('q')!)); return route.fulfill({ json: { items: data, total: data.length, page: 1, pageSize: 20 } }); });
  await page.route('**/api/manage/resources/native-*', route => route.fulfill({ json: folders.find(item => item.id === new URL(route.request().url()).pathname.split('/').pop()) }));
  await login(page);
  const nav = page.getByRole('navigation', { name: '手机导航' });
  await nav.getByRole('link', { name: '内容', exact: true }).click();
  await expect(page.locator('.m-content-item')).toHaveCount(20);
  await page.screenshot({ path: '../../artifacts/mobile-native/library.png', fullPage: true });
  await page.getByRole('button', { name: '切换列表', exact: true }).click();
  await expect(page.locator('.m-collection')).toHaveClass(/list/);
  await page.getByLabel('搜索内容', { exact: true }).fill('小猪佩奇');
  await expect(page.locator('.m-content-item')).toHaveCount(5);
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(page.locator('.m-content-item')).toHaveCount(20);
  await page.getByRole('button', { name: '切换网格' }).click();
  await page.evaluate(() => scrollTo(0, 500));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(500);
  await nav.getByRole('link', { name: '今天' }).click();
  await nav.getByRole('link', { name: '内容' }).click();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(500);
  await page.getByRole('button', { name: '打开 小猪佩奇 9', exact: true }).click();
  await expect(page.getByRole('heading', { name: '小猪佩奇 9', exact: true })).toBeVisible();
  await expect(page.locator('.library-folder-panel')).toHaveCount(0);
  await page.getByRole('link', { name: '返回', exact: true }).click();
  await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
});
test('reconnecting restores failed content loads', async ({ page, context }) => {
  await login(page);
  await context.setOffline(true);
  await page.getByRole('navigation', { name: '手机导航' }).getByRole('link', { name: '内容', exact: true }).click();
  await expect(page.locator('.m-error')).toBeVisible();
  await context.setOffline(false);
  await expect(page.locator('.m-content-item').first()).toBeVisible();
  await expect(page.locator('.m-error')).toHaveCount(0);
});
test('touch operations use contextual sheets, explicit move targets and separate delete confirmation', async ({ page }) => {
  await login(page);
  const session = await (await page.request.get('/api/manage/auth/session')).json(), headers = { 'X-CSRF-Token': session.csrfToken };
  const source = await (await page.request.post('/api/manage/resources', { headers, data: { type: 'Series', name: '晚安故事' } })).json();
  const target = await (await page.request.post('/api/manage/resources', { headers, data: { type: 'Series', name: '周末收藏' } })).json();
  try {
    await page.goto('/manage/#/library');
    await page.getByRole('button', { name: `更多操作 ${source.name}`, exact: true }).click();
    const sheet = page.getByRole('dialog', { name: source.name, exact: true });
    await expect(sheet).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.screenshot({ path: '../../artifacts/mobile-native/actions.png' });
    await sheet.getByRole('button', { name: '移动', exact: true }).click();
    const destination = page.getByRole('dialog', { name: `移动“${source.name}”`, exact: true });
    await expect(destination).toBeVisible();
    await destination.getByRole('button', { name: target.name, exact: true }).click();
    await expect(destination).toHaveCount(0);
    expect((await (await page.request.get(`/api/manage/resources/${source.id}`)).json()).parentId).toBe(target.id);
    await page.getByRole('button', { name: `打开 ${target.name}`, exact: true }).click();
    await page.getByRole('button', { name: `更多操作 ${source.name}`, exact: true }).click();
    await page.getByRole('dialog', { name: source.name, exact: true }).getByRole('button', { name: '移入最近删除', exact: true }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('button', { name: `打开 ${source.name}`, exact: true })).toHaveCount(0);
  } finally {
    for (const item of [source, target]) { await page.request.post(`/api/manage/resources/${item.id}/archive`, { headers }); await page.request.delete(`/api/manage/trash/${item.id}`, { headers }); }
  }
});
test('long press and batch selection have separate touch states', async ({ page }) => {
  await login(page);
  const session = await (await page.request.get('/api/manage/auth/session')).json(), headers = { 'X-CSRF-Token': session.csrfToken };
  const episode = await (await page.request.post('/api/manage/resources', { headers, data: { type: 'Episode', parentId: 'season', name: `选择检查 ${Date.now()}` } })).json();
  try {
    await page.goto('/manage/#/library/season');
    const cover = page.getByRole('button', { name: `打开 ${episode.name}`, exact: true });
    await cover.scrollIntoViewIfNeeded();
    const box = (await cover.boundingBox())!, cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
    await expect(page.getByRole('dialog', { name: episode.name, exact: true })).toBeVisible();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.getByRole('dialog', { name: episode.name, exact: true }).getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '选择', exact: true }).click();
    await page.getByRole('checkbox', { name: `选择视频 ${episode.name}`, exact: true }).click();
    await expect(page.getByRole('group', { name: '已选视频操作' })).toContainText('已选 1 个');
    await expect(page.getByRole('group', { name: '已选视频操作' }).getByRole('button', { name: '上架', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.getByRole('group', { name: '已选视频操作' })).toHaveCount(0);
  } finally { await page.request.post(`/api/manage/resources/${episode.id}/archive`, { headers }); await page.request.delete(`/api/manage/trash/${episode.id}`, { headers }); }
});
test('read-only mobile presentation exposes viewing and omits mutations', async ({ page }) => {
  await page.route('**/api/manage/auth/**', async route => {
    const response = await route.fetch(); const data = await response.json();
    await route.fulfill({ response, json: data.user ? { ...data, user: { ...data.user, role: 'viewer' } } : data });
  });
  await login(page);
  await page.getByRole('navigation', { name: '手机导航' }).getByRole('link', { name: '内容' }).click();
  await expect(page.locator('.m-content-item').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '添加内容', exact: true })).toHaveCount(0);
  await page.locator('.m-content-more').first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: '移动', exact: true })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: '移入最近删除', exact: true })).toHaveCount(0);
});
test('a television card opens only that device’s settings directly', async ({ page }) => {
  const auth = await (await page.request.post('/api/auth/login', { headers: { 'X-Molly-Client': 'tv-shell/2' }, data: { username: 'parent@example.test', password: 'parent' + '-e2e' } })).json();
  await login(page);
  const session = await (await page.request.get('/api/manage/auth/session')).json(), headers = { 'X-CSRF-Token': session.csrfToken };
  try {
    expect((await page.request.patch(`/api/manage/devices/${auth.deviceId}`, { headers, data: { name: '卧室电视' } })).ok()).toBe(true);
    await page.goto('/manage/#/devices');
    await page.reload();
    const card = page.locator('.m-tv-card').filter({ has: page.getByRole('heading', { name: '卧室电视', exact: true }) });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: '观看安排', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '卧室电视 · 观看设置', exact: true });
    await expect(settings).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(settings.getByRole('button', { name: '保存设置', exact: true })).toBeVisible();
    await settings.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page).toHaveURL(/#\/devices$/);
  } finally { await page.request.post(`/api/manage/devices/${auth.deviceId}/revoke`, { headers }); }
});
