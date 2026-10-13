import { chooseSelect } from "./select";
import { test, expect } from '@playwright/test';

test('management lists filter on the server, turn pages and clear cross-page selections', async ({ page }) => {
  const errors: string[] = [];
  const resourceRequests: URL[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/manage/resources') resourceRequests.push(url);
  });
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '资源库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  const folders: { id: string }[] = [];
  for (let index = 0; index < 25; index++) {
    const response = await page.request.post('/api/manage/resources', { headers,
      data: { type: 'Series', name: `分页资源${String(index).padStart(2, '0')}`, indexNumber: index + 1 } });
    expect(response.ok()).toBeTruthy();
    folders.push(await response.json());
  }
  await page.request.post(`/api/manage/resources/${folders[24].id}/unpublish`, { headers });
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '概览', exact: true }).click();
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '资源库', exact: true }).click();
  const rows = page.locator('.resource-row');
  await expect(rows).toHaveCount(20);
  await rows.first().getByRole('checkbox').check();
  await expect(page.locator('.selection-bar')).toBeVisible();
  const pagination = page.getByRole('navigation', { name: '资源库分页', exact: true });
  await pagination.getByRole('button', { name: /下一页/ }).click();
  await expect(pagination).toContainText('第 2 / 2 页');
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索资源', exact: true }).fill('分页资源24');
  await expect(rows).toHaveCount(1);
  await expect(pagination).toContainText('第 1 / 1 页');
  await chooseSelect(page.getByRole('combobox', { name: '资源状态' }), 'published');
  await expect(page.getByText('没有匹配的资源')).toBeVisible();
  await chooseSelect(page.getByRole('combobox', { name: '资源状态' }), 'draft');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('分页资源24');
  await page.screenshot({ path: '../../artifacts/manage-paginated-library.png', fullPage: true });

  await page.getByRole('button', { name: '＋ 上传资源', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const search = dialog.getByRole('textbox', { name: '检索候选名称', exact: true });
  await search.fill('分页资源24');
  await expect(dialog.getByRole('combobox', { name: '文件夹', exact: true })).toBeEnabled();
  await dialog.getByRole('combobox', { name: '文件夹', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await search.press('Enter');
  await expect(dialog).toBeVisible();
  await chooseSelect(dialog.getByRole('combobox', { name: '文件夹', exact: true }), folders[24].id);
  await expect(dialog.getByLabel('新文件夹名称')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '家庭设置' }).click();
  await expect(page.getByRole('heading', { name: '儿童档案', exact: true })).toHaveCount(0);
  await expect(page.locator('input[value="Asia/Shanghai"]')).toBeVisible();
  await page.screenshot({ path: '../../artifacts/manage-paginated-settings.png', fullPage: true });
  expect(resourceRequests.length).toBeGreaterThan(0);
  expect(resourceRequests.every((url) => url.searchParams.has('page'))).toBeTruthy();
  expect(resourceRequests.some((url) => url.searchParams.get('q') === '分页资源24' && url.searchParams.get('page') === '1')).toBeTruthy();
  expect(errors).toEqual([]);
});
