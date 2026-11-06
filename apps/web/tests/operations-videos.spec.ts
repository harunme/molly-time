import { test, expect } from '@playwright/test';
import { chooseSelect } from './select';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('operator@example.test');
  await page.getByLabel('密码', { exact: true }).fill('operator-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: '运营设置' }).click();
  await page.getByRole('tab', { name: '全部视频', exact: true }).click();
}

test('operator searches videos, previews only on demand and opens a user family from the users tab', async ({ page }) => {
  const streams: string[] = [];
  page.on('request', request => {
    if (/\/operations\/videos\/[^/]+\/play/.test(request.url())) streams.push(request.url());
  });
  await login(page);
  const list = page.getByRole('list', { name: '全部视频列表', exact: true });
  await expect(list.locator(':scope > li')).toHaveCount(3);
  expect(streams).toEqual([]);
  await expect(page.locator('video')).toHaveCount(0);
  await page.getByLabel('搜索视频或用户').fill('Browser fixture');
  await expect(list.locator(':scope > li')).toHaveCount(1);
  const preview = page.getByRole('button', { name: '预览 Browser fixture', exact: true });
  await preview.click();
  const dialog = page.getByRole('dialog', { name: 'Browser fixture', exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => streams.length).toBeGreaterThan(0);
  await expect.poll(() => dialog.locator('video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => dialog.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);
  await expect(preview).toBeFocused();
  await page.getByLabel('搜索视频或用户').fill('parent@example.test');
  await expect(list.locator(':scope > li')).toHaveCount(3);
  await chooseSelect(page.getByLabel('存储位置', { exact: true }), 'oss');
  await expect(page.getByText('没有匹配的视频，试试其他关键词或清除筛选。')).toBeVisible();
  await chooseSelect(page.getByLabel('存储位置', { exact: true }), 'local');
  await expect(list.locator(':scope > li')).toHaveCount(3);
  await page.screenshot({ path: '../../artifacts/operations-videos-desktop.png', fullPage: true });
  await page.getByRole('tab', { name: '用户管理', exact: true }).click();
  await page.getByRole('link', { name: '查看 receiver@example.test 的家庭视频', exact: true }).click();
  await expect(page).toHaveURL(/operations\/videos\?userId=receiver/);
  await expect(page.getByText('当前查看所选用户的家庭视频')).toBeVisible();
  await expect(page.getByText('没有匹配的视频，试试其他关键词或清除筛选。')).toBeVisible();
  await page.getByRole('button', { name: '查看所有家庭' }).click();
  await expect(list.locator(':scope > li')).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: '全部视频', exact: true })).toBeVisible();
  await expect(list.locator(':scope > li')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '预览 Browser fixture', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../../artifacts/operations-videos-mobile.png', fullPage: true });
});

test('video list handles pagination, failed refresh, empty filters and preview errors', async ({ page }) => {
  let failed = false;
  await page.route('**/api/manage/operations/videos?*', route => {
    const params = new URL(route.request().url()).searchParams;
    const pageNumber = Number(params.get('page') || 1);
    const total = params.get('q') ? 0 : 21;
    return route.fulfill({ status: failed ? 503 : 200, json: failed ? { detail: '视频列表暂时不可用' } : {
      total, page: pageNumber, pageSize: 20,
      items: total ? Array.from({ length: pageNumber === 1 ? 20 : 1 }, (_, i) => ({
        id: `video-${(pageNumber - 1) * 20 + i}`, itemId: `episode-${i}`, name: `家庭视频 ${(pageNumber - 1) * 20 + i + 1}`,
        filename: '家庭视频.mp4', familyId: 'family', familyName: '我们的家庭',
        accounts: [{ id: 'parent', name: 'parent', email: 'parent@example.test', accountId: '1234567890' }],
        collection: '童年故事 / 第一季', status: 'published', canPreview: true,
        size: 52428800, runtimeMs: 120000, storage: 'local', shared: false, uploadedAt: null,
      })) : [],
    } });
  });
  await page.route('**/api/manage/operations/videos/*/play', route => route.fulfill({ status: 404, body: 'Not found' }));
  await login(page);
  const list = page.getByRole('list', { name: '全部视频列表', exact: true });
  await expect(list.locator(':scope > li')).toHaveCount(20);
  await page.getByRole('button', { name: '全部视频分页：下一页' }).click();
  await expect(list.locator(':scope > li')).toHaveCount(1);
  await expect(list).toContainText('家庭视频 21');
  await page.getByRole('button', { name: '预览 家庭视频 21', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '家庭视频 21' });
  await expect(dialog.getByRole('alert')).toContainText('视频无法播放');
  await expect(dialog.getByRole('button', { name: '重试播放' })).toBeVisible();
  await page.keyboard.press('Escape');
  failed = true;
  await page.getByRole('button', { name: '刷新列表' }).click();
  await expect(page.getByRole('alert')).toContainText('视频列表暂时不可用');
  await expect(list).toContainText('家庭视频 21');
  failed = false;
  await page.getByRole('button', { name: '刷新列表' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('搜索视频或用户').fill('不存在');
  await expect(page.getByText('没有匹配的视频，试试其他关键词或清除筛选。')).toBeVisible();
  await expect(page.getByText('第 1 / 1 页')).toBeVisible();
});
