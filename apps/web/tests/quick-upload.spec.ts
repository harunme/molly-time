import { expect, test, type Page } from '@playwright/test';
import { mp4Fixture } from './mp4-fixture';

async function login(page: Page) {
  await page.goto('/manage/#/library');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资源库', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  return { 'X-CSRF-Token': session.csrfToken };
}
const video = (name: string) => ({ name, mimeType: 'video/mp4', buffer: mp4Fixture() });
async function choose(page: Page, names: string[]) {
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加内容', exact: true }).click();
  await page.getByRole('menuitem', { name: '上传视频', exact: true }).click();
  const chooser = await picker;
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles(names.map(video));
}
async function closeTasks(page: Page) {
  const tasks = page.getByRole('dialog', { name: '上传任务', exact: true });
  await expect(tasks).toBeVisible();
  await tasks.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(tasks).not.toBeVisible();
}
async function remove(page: Page, headers: Record<string, string>, id: string) {
  await page.request.post(`/api/manage/resources/${id}/archive`, { headers });
  await page.request.delete(`/api/manage/trash/${id}`, { headers });
}

test('upload opens the file chooser directly, cancellation writes nothing and a season receives filename titles', async ({ page }) => {
  const headers = await login(page);
  const series = await (await page.request.post('/api/manage/resources', { headers, data: { type: 'Series', name: '直接上传检查' } })).json();
  const season = await (await page.request.post('/api/manage/resources', { headers, data: { type: 'Season', name: '第一季', parentId: series.id } })).json();
  try {
    await page.goto(`/manage/#/library/${season.id}`);
    await expect(page.getByRole('dialog', { name: '第一季', exact: true })).toBeVisible();
    const writes: string[] = [];
    page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
    await choose(page, []);
    await expect(page.getByRole('dialog', { name: '上传资源', exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
    await choose(page, ['第一集.早上好.mp4', '第二集.MP4']);
    await expect(page.getByRole('dialog', { name: '上传任务', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /视频名称|新文件夹名称/ })).toHaveCount(0);
    await expect.poll(async () => (await (await page.request.get(`/api/manage/resources?parentId=${season.id}`)).json()).length).toBe(2);
    const episodes = await (await page.request.get(`/api/manage/resources?parentId=${season.id}`)).json();
    expect(episodes.map((item: { name: string }) => item.name).sort()).toEqual(['第一集.早上好', '第二集']);
    expect(episodes.every((item: { parentId: string; indexNumber: number | null }) => item.parentId === season.id && item.indexNumber === null)).toBe(true);
    await expect.poll(async () => (await (await page.request.get(`/api/manage/resources?parentId=${season.id}`)).json()).every((item: { ready: boolean }) => item.ready)).toBe(true);
    await closeTasks(page);
    await expect(page.getByRole('button', { name: '第一集.早上好', exact: true })).toBeVisible();
  } finally { await remove(page, headers, series.id); }
});

test('root uploads reuse the inbox and a failed batch retries without duplicate resources', async ({ page }) => {
  const headers = await login(page);
  let inboxId = '';
  const existing = await (await page.request.get('/api/manage/resources?q=' + encodeURIComponent('未整理'))).json();
  const originalIds = new Set<string>(existing.length ? (await (await page.request.get(`/api/manage/resources?parentId=${existing[0].id}`)).json()).map((item: { id: string }) => item.id) : []);
  try {
    await choose(page, ['根目录直接上传.mp4']);
    await expect.poll(async () => (await (await page.request.get('/api/manage/resources?q=' + encodeURIComponent('未整理'))).json()).length).toBe(1);
    inboxId = (await (await page.request.get('/api/manage/resources?q=' + encodeURIComponent('未整理'))).json())[0].id;
    await expect.poll(async () => (await (await page.request.get(`/api/manage/resources?parentId=${inboxId}`)).json()).length).toBe(originalIds.size + 1);
    await closeTasks(page);
    let rejected = false;
    await page.route('**/api/manage/uploads', async route => {
      if (route.request().method() === 'POST' && route.request().postDataJSON().filename === '批量重试.mp4' && !rejected) {
        rejected = true;
        return route.fulfill({ status: 503, json: { detail: '上传连接暂时不可用' } });
      }
      return route.continue();
    });
    await choose(page, ['批量先成功.mp4', '批量重试.mp4']);
    const tasks = page.getByRole('dialog', { name: '上传任务', exact: true });
    await expect(tasks.getByRole('alert')).toContainText('上传连接暂时不可用');
    await tasks.getByRole('button', { name: '重试上传', exact: true }).click();
    await expect(tasks.getByRole('alert')).toHaveCount(0);
    await expect.poll(async () => {
      const rows = await (await page.request.get(`/api/manage/resources?parentId=${inboxId}`)).json();
      return rows.length === originalIds.size + 3 && rows.every((row: { ready: boolean }) => row.ready);
    }).toBe(true);
    const roots = await (await page.request.get('/api/manage/resources?q=' + encodeURIComponent('未整理'))).json();
    expect(roots).toHaveLength(1);
    const episodes = await (await page.request.get(`/api/manage/resources?parentId=${inboxId}`)).json();
    expect(episodes.filter((item: { id: string }) => !originalIds.has(item.id)).map((item: { name: string }) => item.name).sort()).toEqual(['批量先成功', '批量重试', '根目录直接上传'].sort());
    await page.goBack();
    await expect(tasks).not.toBeVisible();
    await expect(page).toHaveURL(/#\/library$/);
  } finally {
    if (inboxId && !existing.length) await remove(page, headers, inboxId);
    else if (inboxId) {
      const rows = await (await page.request.get(`/api/manage/resources?parentId=${inboxId}`)).json();
      for (const row of rows) if (!originalIds.has(row.id)) await remove(page, headers, row.id);
    }
  }
});

test('a bad selection creates no resources and the next valid selection still works', async ({ page }) => {
  const headers = await login(page);
  const series = await (await page.request.post('/api/manage/resources', { headers, data: { type: 'Series', name: '上传校验检查' } })).json();
  try {
    await page.goto(`/manage/#/library/${series.id}`);
    const dialog = page.getByRole('dialog', { name: series.name, exact: true });
    await expect(dialog).toBeVisible();
    await page.getByLabel('选择上传视频', { exact: true }).setInputFiles([video('正常.mp4'), { name: '不是视频.txt', mimeType: 'text/plain', buffer: Buffer.from('test') }]);
    await expect(dialog.getByRole('alert')).toContainText('不是 MP4 视频');
    expect(await (await page.request.get(`/api/manage/resources?parentId=${series.id}`)).json()).toEqual([]);
    await choose(page, ['正常.mp4']);
    await closeTasks(page);
    await expect(page.getByRole('button', { name: '正常', exact: true })).toBeVisible();
  } finally { await remove(page, headers, series.id); }
});
