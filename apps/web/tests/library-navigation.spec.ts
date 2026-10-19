import { expect, test } from '@playwright/test';

test('the fixed add tile creates a folder with inline naming', async ({ page }) => {
  await page.goto('/manage/#/library');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const add = page.getByRole('button', { name: '添加内容', exact: true });
  await expect(add).toBeVisible();
  await expect(page.locator('.resource-desktop > :first-child')).toHaveClass('desktop-add-tile');
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/manage/resources');
  await add.click();
  await page.getByRole('menuitem', { name: '新建文件夹', exact: true }).click();
  const folder = await (await created).json();
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  try {
    const input = page.getByRole('textbox', { name: '文件夹名称', exact: true });
    await expect(input).toBeFocused();
    await input.fill('新建入口检查');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: '新建入口检查', exact: true })).toBeVisible();
    await expect(page.locator('.resource-desktop > :first-child')).toHaveClass('desktop-add-tile');
    await expect(page.locator('.desktop-add-tile')).not.toHaveAttribute('data-resource-id');
  } finally {
    await page.request.post(`/api/manage/resources/${folder.id}/archive`, { headers });
    await page.request.delete(`/api/manage/trash/${folder.id}`, { headers });
  }
});

test('opening a folder preserves the add tile and grid during a slow detail request', async ({ page }) => {
  await page.goto('/manage/#/library');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.resource-desktop .name-button')).toContainText(['英语启蒙']);
  const addTile = (await page.locator('.desktop-add-tile').boundingBox())!;
  const tile = (await page.locator('.resource-tile').first().boundingBox())!;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/manage/resources/series', async route => {
    await gate;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '英语启蒙', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '英语启蒙', exact: true })).toBeVisible();
    const background = page.locator('.folder-parent-desktop');
    await expect(background.locator('.desktop-add-art')).toBeVisible();
    const behindAddTile = (await background.locator('.desktop-add-tile').boundingBox())!;
    const behindTile = (await background.locator('.desktop-background-tile').first().boundingBox())!;
    expect(Math.abs(behindAddTile.y - addTile.y)).toBeLessThan(1);
    expect(Math.abs(behindAddTile.height - addTile.height)).toBeLessThan(1);
    expect(Math.abs(behindTile.y - tile.y)).toBeLessThan(1);
    expect(Math.abs(behindTile.x - tile.x)).toBeLessThan(1);
    await page.screenshot({ path: '../../artifacts/library-background-toolbar.png', animations: 'disabled' });
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('closing a folder restores the current library page while a slow refresh runs', async ({ page }) => {
  await page.goto('/manage/#/library');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  const folders: { id: string; name: string }[] = [];
  let release = () => {};
  try {
    for (let i = 0; i < 21; i++) {
      const response = await page.request.post('/api/manage/resources', { headers, data: { type: 'Series', name: `返回列表检查 ${i}` } });
      expect(response.ok()).toBeTruthy();
      folders.push(await response.json());
    }
    await page.reload();
    const pagination = page.getByRole('navigation', { name: '资源库分页', exact: true });
    await pagination.getByRole('button', { name: /下一页/ }).click();
    await expect(pagination).toContainText('第 2 / 2 页');
    const names = await page.locator('.resource-desktop .name-button').allTextContents();
    const target = folders.find(folder => names.includes(folder.name))!;
    expect(target).toBeDefined();
    await page.getByRole('button', { name: target.name, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: target.name, exact: true });
    await expect(dialog).toBeVisible();
    await expect(page.locator('.folder-parent-desktop .name-button')).toHaveText(names);
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/manage/resources?**', async route => {
      if (!new URL(route.request().url()).searchParams.has('parentId')) await gate;
      await route.continue();
    });
    const refreshing = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === '/api/manage/resources' && !url.searchParams.has('parentId');
    });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await refreshing;
    await expect(page.locator('.library-folder-panel')).toHaveCount(0);
    await expect(page.locator('.resource-desktop .name-button')).toHaveText(names);
    await expect(pagination).toContainText('第 2 / 2 页');
    await expect(page.getByText('正在打开…', { exact: true })).toHaveCount(0);
    const updatedName = `${target.name}（已更新）`;
    expect((await page.request.patch(`/api/manage/resources/${target.id}`, { headers, data: { name: updatedName } })).ok()).toBeTruthy();
    release();
    await expect(page.locator('.resource-desktop .name-button')).toHaveText(names.map(name => name === target.name ? updatedName : name));
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    for (const folder of folders) {
      await page.request.post(`/api/manage/resources/${folder.id}/archive`, { headers });
      await page.request.delete(`/api/manage/trash/${folder.id}`, { headers });
    }
  }
});

test('video names edit on the card and subtitle settings have their own menu entry', async ({ page }) => {
  await page.goto('/manage/#/library');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '英语启蒙', exact: true }).click();
  await page.getByRole('button', { name: '第 1 季', exact: true }).click();
  await page.getByRole('button', { name: '更多操作 Browser fixture', exact: true }).click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const input = page.getByRole('textbox', { name: '视频名称', exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Browser fixture');
  await input.fill('暂不修改');
  await input.press('Escape');
  await expect(page.getByRole('button', { name: 'Browser fixture', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '更多操作 Browser fixture', exact: true }).click();
  await page.getByRole('menuitem', { name: '字幕设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '字幕设置 · Browser fixture', exact: true });
  await expect(settings.getByRole('heading', { name: '字幕资源', exact: true })).toBeVisible();
  await expect(settings.getByLabel('字幕类型')).toHaveCount(3);
  await expect(settings.getByRole('textbox', { name: '介绍', exact: true })).toHaveCount(0);
  await expect(settings.getByRole('textbox', { name: '名称', exact: true })).toHaveCount(0);
});

test('nested folders have compact navigation, contextual creation and a separate close action', async ({ page }) => {
  await page.goto('/manage/#/library');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  const create = async (name: string, parentId?: string) => {
    const response = await page.request.post('/api/manage/resources', { headers, data: { name, type: 'Series', parentId } });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const root = await create('Super Simple Songs');
  try {
    const parent = await create('韵律儿歌', root.id);
    await page.goto(`/manage/#/library/${parent.id}`);
    await expect(page.getByRole('dialog', { name: '韵律儿歌', exact: true })).toBeVisible();
    const parentUrl = page.url();
    await page.getByRole('button', { name: '添加内容', exact: true }).click();
    await page.getByRole('menuitem', { name: '新建文件夹', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '新建文件夹', exact: true })).toHaveCount(0);
    const input = page.getByRole('textbox', { name: '文件夹名称', exact: true });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('新建文件夹');
    const newFolders = await (await page.request.get(`/api/manage/resources?parentId=${parent.id}`)).json();
    expect(newFolders).toEqual(expect.arrayContaining([expect.objectContaining({ name: '新建文件夹', type: 'Series' })]));
    await input.fill('新分类');
    await page.screenshot({ path: '../../artifacts/library-create-inline-desktop.png', fullPage: true });
    await input.press('Enter');
    await expect(input).toHaveCount(0);
    await page.getByRole('button', { name: '更多操作 新分类', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '编辑', exact: true })).toHaveCount(0);
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('新分类');
    await expect(page.getByRole('textbox', { name: '介绍', exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await input.fill('动作儿歌');
    await input.press('Enter');
    await expect(input).toHaveCount(0);
    await page.getByRole('button', { name: '更多操作 动作儿歌', exact: true }).click();
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    await input.fill('放弃改名');
    await input.press('Escape');
    await expect(page.getByRole('button', { name: '动作儿歌', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '添加内容', exact: true }).click();
    await page.getByRole('menuitem', { name: '新建文件夹', exact: true }).click();
    await expect(input).toBeFocused();
    await input.press('Escape');
    await expect(page.getByRole('button', { name: '新建文件夹', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: '添加内容', exact: true }).click();
    await page.getByRole('menuitem', { name: '新建文件夹', exact: true }).click();
    await expect(input).toHaveValue('新建文件夹 (2)');
    await input.fill('动作儿歌');
    await input.press('Enter');
    await expect(page.getByRole('alert')).toContainText('同一目录已有这个名称');
    await input.fill('晚安歌');
    await input.press('Tab');
    await expect(page.getByRole('button', { name: '晚安歌', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '动作儿歌', exact: true }).click();
    const nestedUrl = page.url();
    const folder = page.getByRole('dialog', { name: '动作儿歌', exact: true });
    const path = folder.getByRole('navigation', { name: '文件夹路径' });
    await expect(path.getByRole('button')).toHaveText(['全部文件夹', 'Super Simple Songs', '韵律儿歌']);
    await expect(folder.getByRole('button', { name: '新建季', exact: true })).toHaveCount(0);
    const header = folder.locator('.folder-panel-heading');
    expect((await header.boundingBox())!.height).toBeLessThan(110);
    await expect(header.getByRole('button')).toHaveCount(5);
    await expect(folder.locator('.resource-desktop > :first-child')).toHaveClass('desktop-add-tile');
    await page.screenshot({ path: '../../artifacts/library-navigation-desktop.png', fullPage: true });
    await folder.getByRole('button', { name: '返回韵律儿歌', exact: true }).click();
    await expect(page).toHaveURL(parentUrl);
    await page.goBack();
    await expect(page).toHaveURL(nestedUrl);
    await path.getByRole('button', { name: 'Super Simple Songs', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Super Simple Songs', exact: true })).toBeVisible();
    await page.goBack();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(folder).toBeVisible();
    await expect(folder.getByRole('button', { name: '添加内容', exact: true })).toBeInViewport();
    await expect(folder.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
    expect(await folder.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: '../../artifacts/library-navigation-mobile.png', fullPage: true });
    await folder.getByRole('button', { name: '添加内容', exact: true }).click();
    await page.getByRole('menuitem', { name: '新建文件夹', exact: true }).click();
    await expect(input).toBeFocused();
    await page.screenshot({ path: '../../artifacts/library-create-inline-mobile.png', fullPage: true });
    await input.press('Escape');
    await expect(folder).toBeVisible();
    await folder.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.locator('.library-folder-panel')).toHaveCount(0);
  } finally {
    await page.request.post(`/api/manage/resources/${root.id}/archive`, { headers });
    await page.request.delete(`/api/manage/trash/${root.id}`, { headers });
  }
});
