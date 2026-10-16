import { expect, test, type Page, type Locator } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/manage/#/library');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  return { 'X-CSRF-Token': session.csrfToken };
}
async function drag(page: Page, source: Locator, target: Locator, release = true) {
  const from = (await source.boundingBox())!, to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 3 });
  await expect(page.locator('.desktop-drag-ghost')).toBeVisible();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  if (release) await page.mouse.up();
}

test('desktop grid snaps, persists positions, cancels and restores failed moves', async ({ page }) => {
  const headers = await login(page);
  const collection = await (await page.request.post('/api/manage/resources', { headers, data: { name: '桌面拖动检查', type: 'Series' } })).json();
  const names = ['早晨的故事', '森林小冒险', '一起去旅行', '晚安小星星', '认识新朋友', '雨天的游戏'];
  try {
    for (const [index, name] of names.entries()) {
      expect((await page.request.post('/api/manage/resources', { headers, data: { name, type: 'Season', parentId: collection.id, indexNumber: index + 1 } })).ok()).toBeTruthy();
    }
    await page.goto(`/manage/#/library/${collection.id}`);
    const grid = page.locator('.resource-desktop');
    const titles = grid.locator('.name-button');
    await expect(titles).toHaveText(names);
    await grid.getByRole('button', { name: `打开 ${names[0]}`, exact: true }).hover();
    await expect(grid.getByRole('checkbox')).toHaveCount(0);
    await expect(grid.getByRole('button', { name: /^拖动 / })).toHaveCount(0);
    await expect(page.locator('.resource-list-heading')).toHaveCount(0);
    const saved = page.waitForResponse((response) => response.url().endsWith('/position') && response.request().method() === 'PUT');
    await drag(page, grid.getByRole('button', { name: `打开 ${names[0]}`, exact: true }), grid.getByRole('button', { name: `打开 ${names[2]}`, exact: true }));
    expect((await saved).ok()).toBeTruthy();
    const ordered = [names[1], names[2], names[0], ...names.slice(3)];
    await expect(titles).toHaveText(ordered);
    await page.reload();
    await expect(titles).toHaveText(ordered);
    await page.screenshot({ path: '../../artifacts/library-desktop.png', fullPage: true, animations: 'disabled' });
    await drag(page, grid.getByRole('button', { name: `打开 ${names[1]}`, exact: true }), grid.getByRole('button', { name: `打开 ${names[3]}`, exact: true }), false);
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(titles).toHaveText(ordered);
    await expect(page.locator('.desktop-drag-ghost')).toHaveCount(0);
    const cancelledWrites: string[] = [];
    const recordWrite = (request: import('@playwright/test').Request) => {
      if (['PUT', 'POST'].includes(request.method()) && /\/(position|move)$/.test(request.url())) cancelledWrites.push(request.url());
    };
    page.on('request', recordWrite);
    await drag(page, grid.getByRole('button', { name: `打开 ${names[1]}`, exact: true }), grid.getByRole('button', { name: `打开 ${names[3]}`, exact: true }), false);
    const cancel = page.locator('.desktop-cancel-drop');
    const cancelBox = (await cancel.boundingBox())!;
    await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2, { steps: 12 });
    await expect(cancel).toHaveAttribute('data-active', 'true');
    await expect(cancel).toContainText('松开取消');
    await page.screenshot({ path: '../../artifacts/library-cancel-move.png', fullPage: true, animations: 'disabled' });
    await page.mouse.up();
    await expect(cancel).toHaveCount(0);
    await expect(titles).toHaveText(ordered);
    await expect(page.locator('.desktop-drag-ghost')).toHaveCount(0);
    expect(cancelledWrites).toEqual([]);
    page.off('request', recordWrite);
    await page.route('**/api/manage/resources/*/position', (route) => route.fulfill({ status: 409, json: { detail: '保存失败，请重试' } }));
    await drag(page, grid.getByRole('button', { name: `打开 ${names[1]}`, exact: true }), grid.getByRole('button', { name: `打开 ${names[3]}`, exact: true }));
    await expect(page.getByRole('alert')).toContainText('保存失败');
    await expect(titles).toHaveText(ordered);
    await page.unroute('**/api/manage/resources/*/position');
    const cover = grid.getByRole('button', { name: `打开 ${names[1]}`, exact: true });
    await cover.focus(); await cover.press('Alt+ArrowRight');
    await expect(titles).toHaveText([names[2], names[1], names[0], ...names.slice(3)]);
    await expect(grid).toHaveAttribute('aria-busy', 'false');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '../../artifacts/library-desktop-mobile.png', fullPage: true, animations: 'disabled' });
    // Holding a cover lifts it; an ordinary swipe can still scroll.
    const touchSource = grid.getByRole('button', { name: `打开 ${names[2]}`, exact: true });
    await touchSource.scrollIntoViewIfNeeded();
    const from = (await touchSource.boundingBox())!, to = (await grid.getByRole('button', { name: `打开 ${names[1]}`, exact: true }).boundingBox())!;
    await touchSource.dispatchEvent('pointerdown', { pointerId: 9, pointerType: 'touch', button: 0, clientX: from.x + 10, clientY: from.y + 10 });
    await expect(page.locator('.desktop-drag-ghost')).toBeVisible();
    await page.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, pointerType: 'touch', clientX: x, clientY: y, cancelable: true })), { x: to.x + to.width / 2, y: to.y + to.height / 2 });
    await expect(page.locator('.desktop-drag-ghost')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'touch' })));
    await expect(grid).toHaveAttribute('aria-busy', 'false');
    await expect(titles).toHaveText(ordered);
  } finally {
    await page.request.post(`/api/manage/resources/${collection.id}/archive`, { headers });
    await page.request.delete(`/api/manage/trash/${collection.id}`, { headers });
  }
});

test('dropping a video onto a season highlights the receiving folder and moves it', async ({ page }) => {
  const headers = await login(page);
  const collection = await (await page.request.post('/api/manage/resources', { headers, data: { name: '拖入季检查', type: 'Series' } })).json();
  try {
    const season = await (await page.request.post('/api/manage/resources', { headers, data: { name: '第一季', type: 'Season', parentId: collection.id, indexNumber: 1 } })).json();
    const episode = await (await page.request.post('/api/manage/resources', { headers, data: { name: '小小冒险', type: 'Episode', parentId: collection.id, indexNumber: 3 } })).json();
    await page.goto(`/manage/#/library/${collection.id}`);
    const grid = page.locator('.resource-desktop');
    await expect(grid.locator('.resource-tile')).toHaveCount(2);
    await drag(page, grid.getByRole('button', { name: '打开 小小冒险', exact: true }), grid.getByRole('button', { name: '打开 第一季', exact: true }), false);
    await expect(grid.locator('.is-drop-target')).toContainText('第一季');
    await expect(grid.getByText('松开移入这一季')).toBeVisible();
    await page.screenshot({ path: '../../artifacts/library-desktop-drag.png', fullPage: true });
    await page.mouse.up();
    await expect(grid.getByRole('button', { name: '小小冒险', exact: true })).toHaveCount(0);
    expect((await (await page.request.get(`/api/manage/resources/${episode.id}`)).json()).parentId).toBe(season.id);
    await grid.getByRole('button', { name: '第一季', exact: true }).click();
    await expect(page.locator('.resource-desktop').getByRole('button', { name: '小小冒险', exact: true })).toBeVisible();
  } finally {
    await page.request.post(`/api/manage/resources/${collection.id}/archive`, { headers });
    await page.request.delete(`/api/manage/trash/${collection.id}`, { headers });
  }
});

test('hovering a folder opens a group, keeps its subtree and supports moving back out', async ({ page }) => {
  const headers = await login(page);
  const create = async (name: string, type = 'Series', parentId?: string, indexNumber?: number) => {
    const response = await page.request.post('/api/manage/resources', { headers, data: { name, type, parentId, indexNumber } });
    expect(response.ok()).toBeTruthy(); return response.json();
  };
  const source = await create('分组拖动 · 森林故事');
  const target = await create('分组拖动 · 睡前收藏');
  try {
    const season = await create('第一季', 'Season', source.id, 1);
    await create('和小熊做朋友', 'Episode', season.id, 3);
    await page.reload();
    const grid = page.locator('.resource-desktop');
    await expect(grid.getByRole('button', { name: `打开 ${source.name}`, exact: true })).toBeVisible();
    await drag(page, grid.getByRole('button', { name: `打开 ${source.name}`, exact: true }), grid.getByRole('button', { name: `打开 ${target.name}`, exact: true }), false);
    await expect(grid.locator('.is-group-pending')).toBeVisible();
    await expect(grid.locator('.is-drop-target')).toContainText(target.name);
    await expect(grid.getByText('松开移入文件夹')).toBeVisible();
    await expect(grid.locator('.desktop-group-preview')).toBeVisible();
    await page.screenshot({ path: '../../artifacts/library-folder-group-hover.png', fullPage: true });
    await page.mouse.up();
    await expect(grid.getByRole('button', { name: source.name, exact: true })).toHaveCount(0);
    expect((await (await page.request.get(`/api/manage/resources/${source.id}`)).json()).parentId).toBe(target.id);
    await page.reload();
    await page.getByRole('button', { name: target.name, exact: true }).click();
    await expect(page.locator('.resource-desktop').getByRole('button', { name: source.name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: source.name, exact: true }).click();
    await expect(page.getByRole('button', { name: `返回${target.name}`, exact: true })).toBeVisible();
    await page.getByRole('button', { name: '第一季', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '第一季', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `返回${source.name}`, exact: true })).toBeVisible();
    await expect(page.locator('.resource-desktop').getByRole('button', { name: '和小熊做朋友', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('dialog', { name: '第一季', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '../../artifacts/library-folder-group-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: `返回${source.name}`, exact: true }).click();
    await page.getByRole('button', { name: `返回${target.name}`, exact: true }).click();
    await page.getByRole('button', { name: `更多操作 ${source.name}`, exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '移到上一级', exact: true })).toBeVisible();
    await expect(page.getByRole('menu').locator('svg')).toHaveCount(0);
    expect((await page.getByRole('menu').boundingBox())!.width).toBeLessThanOrEqual(120);
    expect((await page.getByRole('menuitem', { name: '重命名', exact: true }).boundingBox())!.height).toBeLessThanOrEqual(24);
    await page.screenshot({ path: '../../artifacts/library-compact-menu.png', fullPage: true, animations: 'disabled' });
    await page.getByRole('menuitem', { name: '移到上一级', exact: true }).click();
    await expect(page.locator('.resource-tile')).toHaveCount(0);
    await page.getByRole('button', { name: '返回全部文件夹', exact: true }).click();
    await expect(page.getByRole('button', { name: source.name, exact: true })).toBeVisible();
  } finally {
    for (const item of [source, target]) {
      await page.request.post(`/api/manage/resources/${item.id}/archive`, { headers });
      await page.request.delete(`/api/manage/trash/${item.id}`, { headers });
    }
  }
});


test('folder overlays preserve a continuous drag out, cancel, retry and drop into another folder', async ({ page }) => {
  const headers = await login(page);
  const create = async (name: string, type = 'Series', parentId?: string) => {
    const response = await page.request.post('/api/manage/resources', { headers, data: { name, type, parentId } });
    expect(response.ok()).toBeTruthy(); return response.json();
  };
  const outer = await create('浮层检查 · 收藏');
  const inner = await create('浮层检查 · 森林故事');
  const sibling = await create('浮层检查 · 睡前故事');
  const moveTo = async (id: string, folderId: string) => expect((await page.request.post(`/api/manage/resources/${id}/move`, { headers, data: { folderId } })).ok()).toBeTruthy();
  const leavePanel = async (name: string) => {
    const dialog = page.getByRole('dialog', { name, exact: true });
    const box = (await dialog.boundingBox())!;
    await page.mouse.move(3, box.y + box.height / 2, { steps: 12 });
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.desktop-drag-ghost')).toBeVisible();
  };
  const lift = async (name: string) => {
    const cover = page.getByRole('button', { name: `打开 ${name}`, exact: true });
    await cover.hover();
    const box = (await cover.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2);
    await expect(page.locator('.desktop-drag-ghost')).toBeVisible();
  };
  const dropOnBlank = async () => {
    const box = (await page.locator('.resource-desktop').boundingBox())!;
    await page.mouse.move(box.x + box.width - 8, box.y + box.height + 12);
    await page.mouse.up();
  };
  try {
    await moveTo(inner.id, outer.id); await moveTo(sibling.id, outer.id);
    const season = await create('第一季', 'Season', inner.id);
    const video = await create('和小熊做朋友', 'Episode', season.id);
    await page.goto(`/manage/#/library/${season.id}`);
    const dialog = page.getByRole('dialog', { name: '第一季', exact: true });
    await expect(dialog).toBeVisible();
    await expect(page.locator('.folder-parent-desktop')).toBeVisible();
    await page.screenshot({ path: '../../artifacts/library-folder-overlay.png', fullPage: true, animations: 'disabled' });
    await lift(video.name); await leavePanel('第一季');
    expect((await (await page.request.get(`/api/manage/resources/${video.id}`)).json()).parentId).toBe(season.id);
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: video.name, exact: true })).toBeVisible();
    await page.route(`**/api/manage/resources/${video.id}/move`, route => route.fulfill({ status: 409, json: { detail: '目标已有同名内容' } }));
    await lift(video.name); await leavePanel('第一季'); await dropOnBlank();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('目标已有同名内容');
    await page.unroute(`**/api/manage/resources/${video.id}/move`);
    await lift(video.name); await leavePanel('第一季');
    await page.screenshot({ path: '../../artifacts/library-folder-drag-out.png', fullPage: true, animations: 'disabled' });
    await dropOnBlank();
    await expect(page).toHaveURL(new RegExp(`/library/${inner.id}$`));
    expect((await (await page.request.get(`/api/manage/resources/${video.id}`)).json()).parentId).toBe(inner.id);
    // Drag a season out of its folder and straight into a sibling folder, without releasing.
    await lift('第一季'); await leavePanel(inner.name);
    const target = (await page.getByRole('button', { name: `打开 ${sibling.name}`, exact: true }).boundingBox())!;
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
    await expect(page.locator('.is-drop-target')).toContainText(sibling.name);
    await page.mouse.up();
    await expect(page).toHaveURL(new RegExp(`/library/${outer.id}$`));
    expect((await (await page.request.get(`/api/manage/resources/${season.id}`)).json()).parentId).toBe(sibling.id);
    // A folder can also return to the root desktop.
    await lift(inner.name); await leavePanel(outer.name); await dropOnBlank();
    await expect(page).toHaveURL(/#\/library$/);
    await page.reload();
    await expect(page.getByRole('button', { name: inner.name, exact: true })).toBeVisible();
    expect((await (await page.request.get(`/api/manage/resources/${inner.id}`)).json()).parentId).toBeNull();
  } finally {
    for (const item of [inner, outer, sibling]) {
      await page.request.post(`/api/manage/resources/${item.id}/archive`, { headers });
      await page.request.delete(`/api/manage/trash/${item.id}`, { headers });
    }
  }
});

test('folder overlay closes outside, follows history, and supports touch drag out', async ({ page }) => {
  const headers = await login(page);
  const outer = await (await page.request.post('/api/manage/resources', { headers, data: { type: 'Series', name: '手机浮层检查' } })).json();
  const inner = await (await page.request.post('/api/manage/resources', { headers, data: { type: 'Season', parentId: outer.id, name: '第一季' } })).json();
  const video = await (await page.request.post('/api/manage/resources', { headers, data: { type: 'Episode', parentId: inner.id, name: '一起去旅行' } })).json();
  try {
    await page.reload();
    await page.getByRole('button', { name: outer.name, exact: true }).click();
    await expect(page.getByRole('dialog', { name: outer.name, exact: true })).toBeVisible();
    await page.mouse.click(250, 150);
    await expect(page).toHaveURL(/#\/library$/);
    await expect(page.getByRole('button', { name: `打开 ${outer.name}`, exact: true })).not.toBeFocused();
    await page.goBack();
    await expect(page.getByRole('dialog', { name: outer.name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: '第一季', exact: true }).click();
    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = page.getByRole('dialog', { name: '第一季', exact: true });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '../../artifacts/library-folder-overlay-mobile.png', fullPage: true, animations: 'disabled' });
    const cover = dialog.getByRole('button', { name: `打开 ${video.name}`, exact: true });
    const from = (await cover.boundingBox())!;
    await cover.dispatchEvent('pointerdown', { pointerId: 21, pointerType: 'touch', button: 0, clientX: from.x + 20, clientY: from.y + 20 });
    await expect(page.locator('.desktop-drag-ghost')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 21, pointerType: 'touch', clientX: 3, clientY: 200, cancelable: true })));
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.desktop-drag-ghost')).toBeVisible();
    const cancel = page.locator('.desktop-cancel-drop');
    const cancelBox = (await cancel.boundingBox())!;
    await page.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 21, pointerType: 'touch', clientX: x, clientY: y, cancelable: true })), { x: cancelBox.x + cancelBox.width / 2, y: cancelBox.y + cancelBox.height / 2 });
    await expect(cancel).toHaveAttribute('data-active', 'true');
    await page.screenshot({ path: '../../artifacts/library-cancel-mobile.png', fullPage: true, animations: 'disabled' });
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 21, pointerType: 'touch' })));
    await expect(dialog).toBeVisible();
    await expect(cancel).toHaveCount(0);
    expect((await (await page.request.get(`/api/manage/resources/${video.id}`)).json()).parentId).toBe(inner.id);
    const retry = (await cover.boundingBox())!;
    await cover.dispatchEvent('pointerdown', { pointerId: 21, pointerType: 'touch', button: 0, clientX: retry.x + 20, clientY: retry.y + 20 });
    await expect(page.locator('.desktop-drag-ghost')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 21, pointerType: 'touch', clientX: 3, clientY: 200, cancelable: true })));
    await expect(dialog).not.toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 21, pointerType: 'touch', clientX: 370, clientY: 700, cancelable: true })));
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 21, pointerType: 'touch' })));
    await expect(page).toHaveURL(new RegExp(`/library/${outer.id}$`));
    expect((await (await page.request.get(`/api/manage/resources/${video.id}`)).json()).parentId).toBe(outer.id);
  } finally {
    await page.request.post(`/api/manage/resources/${outer.id}/archive`, { headers });
    await page.request.delete(`/api/manage/trash/${outer.id}`, { headers });
  }
});
