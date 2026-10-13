import { expect, test, type Page } from '@playwright/test';
import type { Upload } from '../src/api';

async function login(page: Page, path = '/manage/#/library') {
  await page.goto(path);
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.page-title h1')).toHaveText('资源库');
}

const task = (index: number): Upload => ({ id: `task-${index}`, itemId: 'episode', filename: `英语启蒙故事-第${index + 1}集.mp4`,
  size: 1024, offset: 1024, status: 'ready', fingerprint: 'fixture', kind: 'video', error: '', taskId: null, taskStatus: null });

test('task modal preserves folder filters and selection and supports browser history', async ({ page }) => {
  await login(page);
  const navigation = page.getByRole('navigation', { name: '管理导航' });
  await expect(navigation.getByRole('link', { name: '上传任务', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '英语启蒙', exact: true }).click();
  await expect(page.getByRole('heading', { name: '英语启蒙', exact: true })).toBeVisible();
  const search = page.getByRole('textbox', { name: '搜索资源', exact: true });
  await search.fill('Hello');
  await expect(page.locator('.resource-row')).toHaveCount(1);
  await page.getByRole('checkbox', { name: '选择 Hello', exact: true }).check();
  let requests = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/manage/uploads') requests++; });
  expect(requests).toBe(0);
  const trigger = page.getByRole('button', { name: '上传任务', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '上传任务', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator('input[aria-label="搜索资源"]')).toHaveValue('Hello');
  await expect(page).toHaveURL(/\/library\/series\?uploads=1$/);
  await expect.poll(() => requests).toBe(1);
  await page.goBack();
  await expect(dialog).not.toBeVisible();
  await expect(search).toHaveValue('Hello');
  await expect(page.getByRole('checkbox', { name: '选择 Hello', exact: true })).toBeChecked();
  await page.goForward();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(/\/library\/series$/);
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
  const items = Array.from({ length: 21 }, (_, index) => task(index));
  items[0] = { ...items[0], status: 'uploading', offset: 0 };
  items[20] = { ...items[20], status: 'failed', taskId: 'failed-job' };
  await page.route('**/api/manage/uploads?*', (route) => {
    const url = new URL(route.request().url());
    const page = Number(url.searchParams.get('page'));
    return route.fulfill({ json: { items: items.slice((page - 1) * 20, page * 20), total: 21, page, pageSize: 20 } });
  });
  await page.route('**/api/manage/tasks/failed-job/retry', (route) => route.fulfill({ status: 503, json: { detail: '处理任务重试失败' } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('button', { name: '上传任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上传任务', exact: true });
  await expect(dialog.locator('.upload-task')).toHaveCount(20);
  await expect(dialog.getByRole('button', { name: '继续管理资源', exact: true })).toHaveCount(0);
  const ready = dialog.locator('.upload-task[data-status="ready"]').first();
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
      if (request.method() === 'POST') row = { ...row, fingerprint: request.postDataJSON().fingerprint };
      await route.fulfill({ json: request.method() === 'POST' ? row : { items: [row], total: 1, page: 1, pageSize: 20 } });
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
    await page.evaluate(async () => {
      // @ts-expect-error Browser-side Vite module import.
      const { enqueue } = await import('/manage/src/uploads.ts');
      await enqueue(new File([new Uint8Array(16)], '后台任务.mp4', { type: 'video/mp4' }), 'episode', 'video');
    });
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
    await page.getByRole('button', { name: '上传任务', exact: true }).click();
    await expect(dialog.getByText('文件就绪', { exact: true })).toBeVisible();
  } finally { releaseChunk(); }
});
