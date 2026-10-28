import { expect, test, type Page } from '@playwright/test';
import type { Upload } from '../src/api';
import { mp4Fixture } from './mp4-fixture';

async function login(page: Page, path = '/manage/#/library') {
  await page.goto(path);
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.page-title h1')).toHaveText('资源库');
}

const task = (index: number): Upload => ({ id: `task-${index}`, itemId: 'episode', filename: `英语启蒙故事-第${index + 1}集.mp4`,
  size: 1024, offset: 1024, status: 'ready', fingerprint: 'fixture', kind: 'video', error: '', taskId: null, taskStatus: null });

test('menu cover upload opens the picker directly and shows progress and errors on its card', async ({ page }) => {
  await login(page);
  const tile = page.locator('.resource-tile').filter({ has: page.getByRole('button', { name: '英语启蒙', exact: true }) });
  const original = await tile.locator('img').getAttribute('src');
  const choose = async (files: Parameters<import('@playwright/test').FileChooser['setFiles']>[0]) => {
    await tile.getByRole('button', { name: '更多操作 英语启蒙', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '编辑', exact: true })).toHaveCount(0);
    const picker = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: '上传封面', exact: true }).click();
    await (await picker).setFiles(files);
  };
  await choose([]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await choose({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await expect(tile.getByRole('alert')).toContainText('封面图片无效');
  await page.mouse.move(0, 0); // Compare the poster, not a hovered animated preview.
  await expect(tile.locator('img')).toHaveAttribute('src', original!);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/manage/uploads/*/complete', async route => {
    await gate;
    await route.continue();
  });
  try {
    const completing = page.waitForRequest('**/api/manage/uploads/*/complete');
    await choose({
      name: 'cover.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAE0lEQVR4nGNkaGDACpiwCw9WCQBqCACQJ5at+QAAAABJRU5ErkJggg==', 'base64'),
    });
    await completing;
    await expect(tile.getByRole('status')).toHaveText('正在上传封面…');
    await page.mouse.move(0, 0);
    await expect(tile.locator('img')).toHaveAttribute('src', original!);
    await expect(page.getByRole('button', { name: '上传任务', exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    release();
    await expect(tile.getByRole('status')).toHaveCount(0);
    const resource = await (await page.request.get('/api/manage/resources/series')).json();
    await page.mouse.move(0, 0);
    await expect(tile.locator('img')).toHaveAttribute('src', resource.imageUrl);
    await expect(tile.locator('img')).toHaveAttribute('data-loaded', 'true');
    await expect(tile.locator('.desktop-folder-badge')).toBeVisible();
    expect(await tile.locator('.desktop-cover').evaluate(node => getComputedStyle(node, '::before').display)).toBe('none');
    await page.screenshot({ path: '../../artifacts/library-folder-cover.png', fullPage: true });
    await expect(tile.getByRole('alert')).toHaveCount(0);
    await expect(page).toHaveURL(/\/library$/);
  } finally { release(); }
});

test('task modal preserves the current folder and supports browser history', async ({ page }) => {
  await page.route('**/api/manage/uploads?*', (route) => route.fulfill({ json: { items: [{ ...task(0), status: 'uploading', offset: 0 }], total: 1, page: 1, pageSize: Number(new URL(route.request().url()).searchParams.get('pageSize')) } }));
  await login(page);
  const navigation = page.getByRole('navigation', { name: '管理导航' });
  await expect(navigation.getByRole('link', { name: '上传任务', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '上传任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '英语启蒙', exact: true }).click();
  await expect(page.getByRole('button', { name: '上传任务', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '第 1 季', exact: true }).click();
  await expect(page.getByRole('heading', { name: '第 1 季', exact: true })).toBeVisible();
  await expect(page.locator('.resource-tile')).toHaveCount(3);
  let requests = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/manage/uploads') requests++; });
  await expect(page.getByRole('button', { name: '上传任务', exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.location.hash = '/library/season?uploads=1'; });
  const dialog = page.getByRole('dialog', { name: '上传任务', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/library\/season\?uploads=1$/);
  await expect.poll(() => requests).toBeGreaterThanOrEqual(1);
  await page.goBack();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '第 1 季', exact: true })).toBeVisible();
  await page.goForward();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '添加内容', exact: true })).toBeFocused();
  await expect(page).toHaveURL(/\/library\/season$/);
});

test('legacy task links and refreshed modal links return to the resource library', async ({ page }) => {
  await login(page, '/manage/#/upload');
  const dialog = page.getByRole('dialog', { name: '上传任务', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/library\?uploads=1$/);
  await page.reload();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
});

test('task pagination and action errors remain inside the modal on mobile', async ({ page }) => {
  const items = Array.from({ length: 21 }, (_, index) => ({ ...task(index), status: 'processing' }));
  items[0] = { ...items[0], status: 'uploading', offset: 0 };
  items[20] = { ...items[20], status: 'failed', taskId: 'failed-job' };
  await page.route('**/api/manage/uploads?*', (route) => {
    const url = new URL(route.request().url());
    const page = Number(url.searchParams.get('page'));
    const pageSize = Number(url.searchParams.get('pageSize'));
    return route.fulfill({ json: { items: items.slice((page - 1) * pageSize, page * pageSize), total: 21, page, pageSize } });
  });
  await page.route('**/api/manage/tasks/failed-job/retry', (route) => route.fulfill({ status: 503, json: { detail: '处理任务重试失败' } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('button', { name: '上传任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上传任务', exact: true });
  await expect(dialog.locator('.upload-task')).toHaveCount(20);
  await expect(dialog.getByRole('button', { name: '继续管理资源', exact: true })).toHaveCount(0);
  const ready = dialog.locator('.upload-task[data-status="processing"]').first();
  expect((await ready.boundingBox())!.height).toBeLessThan(80);
  await expect(ready.getByRole('progressbar')).toHaveCount(0);
  await page.screenshot({ path: '../../artifacts/manage-upload-list-mobile.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect((await ready.boundingBox())!.height).toBeLessThan(56);
  await page.screenshot({ path: '../../artifacts/manage-upload-list-desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByLabel('重新选择原文件').setInputFiles({ name: 'wrong.mp4', mimeType: 'video/mp4', buffer: Buffer.from('wrong') });
  await expect(dialog.getByRole('alert')).toContainText('所选文件与原文件不一致');
  const body = dialog.locator('[data-slot="dialog-body"]');
  expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
  await dialog.getByRole('navigation', { name: '上传任务分页', exact: true }).getByRole('button', { name: /下一页/ }).click();
  await expect(dialog.locator('.upload-task')).toHaveCount(1);
  await dialog.getByRole('button', { name: '重试处理', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('处理任务重试失败');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../../artifacts/manage-upload-dialog-mobile.png', fullPage: true, animations: 'disabled' });
});

test('readonly members can view tasks without upload controls', async ({ page }) => {
  await page.route('**/api/manage/auth/login', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ json: { ...data, user: { ...data.user, role: 'member' } } });
  });
  await page.route('**/api/manage/uploads?*', (route) => route.fulfill({ json: {
    items: [{ ...task(0), status: 'uploading', offset: 0 }, { ...task(1), status: 'failed', taskId: 'failed-job' }],
    total: 2, page: 1, pageSize: 20,
  } }));
  await login(page);
  await page.getByRole('button', { name: '上传任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上传任务', exact: true });
  await expect(dialog.locator('.upload-task')).toHaveCount(2);
  await expect(dialog.getByRole('button', { name: /暂停|继续上传|重试处理|取消任务|删除失败文件/ })).toHaveCount(0);
  await expect(dialog.getByLabel('重新选择原文件')).toHaveCount(0);
});

test('pausing, resuming and closing the task modal preserve background upload', async ({ page }) => {
  let row = { ...task(0), id: 'background-upload', filename: '后台任务.mp4', size: 16, offset: 0, status: 'uploading' };
  let releaseChunk!: () => void;
  const gate = new Promise<void>((resolve) => { releaseChunk = resolve; });
  await page.route('**/api/manage/uploads**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/uploads/options')) {
      await route.continue();
    } else if (url.pathname.endsWith('/uploads')) {
      if (request.method() === 'POST') row = { ...row, size: request.postDataJSON().size, fingerprint: request.postDataJSON().fingerprint };
      await route.fulfill({ json: request.method() === 'POST' ? row : { items: row.status === 'ready' ? [] : [row], total: row.status === 'ready' ? 0 : 1, page: 1, pageSize: Number(url.searchParams.get('pageSize')) } });
    } else if (url.pathname.endsWith('/chunks')) {
      await gate;
      row = { ...row, offset: row.size };
      await route.fulfill({ json: row });
    } else if (url.pathname.endsWith('/complete')) {
      row = { ...row, status: 'ready' };
      await route.fulfill({ json: row });
    } else await route.fulfill({ json: row });
  });
  try {
    await login(page);
    const chunk = page.waitForRequest((request) => request.url().includes('/background-upload/chunks'));
    await page.evaluate(async (encoded) => {
      // @ts-expect-error Browser-side Vite module import.
      const { enqueue } = await import('/manage/src/uploads.ts');
      await enqueue(new File([Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))], '后台任务.mp4', { type: 'video/mp4' }), 'episode', 'video');
    }, mp4Fixture().toString('base64'));
    await chunk;
    await page.getByRole('button', { name: '上传任务', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '上传任务', exact: true });
    await dialog.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(dialog.getByText('已暂停，可继续上传。', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '继续上传', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
    await page.screenshot({ path: '../../artifacts/manage-upload-dialog-desktop.png', fullPage: true, animations: 'disabled' });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const completed = page.waitForResponse((response) => response.url().endsWith('/background-upload/complete') && response.ok());
    releaseChunk();
    await completed;
    await expect(page.getByRole('button', { name: '上传任务', exact: true })).toHaveCount(0);
  } finally { releaseChunk(); }
});


test('completed uploads are hidden and the add tile opens creation actions', async ({ page }) => {
  await page.route('**/api/manage/uploads?*', (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('pending')).toBe('true');
    return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: Number(url.searchParams.get('pageSize')) } });
  });
  await login(page);
  await expect(page.getByRole('button', { name: '上传任务', exact: true })).toHaveCount(0);
  const add = page.getByRole('button', { name: '添加内容', exact: true });
  await expect(add).toBeVisible();
  await expect(page.locator('.resource-library-card > .library-toolbar')).toHaveCount(0);
  await add.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: '新建文件夹', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '上传视频', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
  await expect(page.locator('.page-title').getByRole('button', { name: '新建文件夹', exact: true })).toHaveCount(0);
  await page.screenshot({ path: '../../artifacts/manage-library-actions-desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../../artifacts/manage-library-actions-mobile.png', fullPage: true, animations: 'disabled' });
});
