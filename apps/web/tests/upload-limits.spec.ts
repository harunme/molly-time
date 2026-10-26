import { expect, test, type Locator } from '@playwright/test';

async function selectOversizeFile(input: Locator, size: number) {
  // Override metadata instead of allocating a 500 MB browser fixture.
  await input.evaluate((element, fileSize) => {
    const file = new File(['test'], 'too-large.mp4', { type: 'video/mp4' });
    Object.defineProperty(file, 'size', { value: fileSize });
    Object.defineProperty(element, 'files', { configurable: true, value: [file] });
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, size);
}

test('oversize videos are rejected before resources or upload sessions are created', async ({ page }) => {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
  const limits = await (await page.request.get('/api/manage/uploads/options')).json();
  expect(limits.video).toBe(500 * 1024**2);
  const created: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/manage\/(resources|uploads|reminders\/[^/]+\/upload-target)$/.test(new URL(request.url()).pathname)) {
      created.push(request.url());
    }
  });
  const navigation = page.getByRole('navigation', { name: '管理导航' });
  await navigation.getByRole('link', { name: '资源库', exact: true }).click();
  const upload = page.getByLabel('选择上传视频', { exact: true });
  await expect(upload).toBeAttached();
  await selectOversizeFile(upload, limits.video + 1);
  await expect(page.getByRole('alert')).toContainText('超过单个视频上限 500.0 MB');
  expect(created).toEqual([]);

  await navigation.getByRole('link', { name: '家庭设置', exact: true }).click();
  await page.getByRole('tab', { name: '电视管理', exact: true }).click();
  await expect(page.getByText('单个视频上限：500.0 MB', { exact: true })).toBeVisible();
  for (const label of ['上传剩 1 集提醒视频', '上传休息提醒视频']) {
    const input = page.getByLabel(label, { exact: true });
    await expect(input).toBeEnabled();
    await selectOversizeFile(input, limits.video + 1);
    await expect(page.getByRole('alert')).toContainText('超过单个视频上限 500.0 MB');
    expect(created).toEqual([]);
  }
});
