import { expect, test } from '@playwright/test';

test('trash action icons align with the header across multiple rows', async ({ page }) => {
  const storage = { usedBytes: 0, reclaimableBytes: 0, ossBytes: 0, localBytes: 0, unknownSizeCount: 0 };
  await page.route('**/api/manage/trash?*', route => route.fulfill({ json: {
    items: Array.from({ length: 9 }, (_, index) => ({ id: `row-${index}`, name: `文件夹 ${index + 1}`, type: 'Series',
      archivedAt: '2026-10-19T06:58:36Z', deleteAt: '2026-10-26T06:58:36Z', videoCount: 0, deleting: false, error: '', storage })),
    page: 1, pageSize: 20, total: 9, entryCount: 9, retentionDays: 7, storage,
  } }));
  await page.goto('/manage/#/trash');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const header = page.locator('.trash-table th').filter({ hasText: '操作' });
  await expect(page.locator('.trash-row-actions')).toHaveCount(9);
  const start = await header.evaluate(el => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
  for (const group of await page.locator('.trash-row-actions').all()) {
    const icon = (await group.locator('button').first().locator('svg').boundingBox())!;
    expect(Math.abs(icon.x - start)).toBeLessThan(1);
  }
  await page.screenshot({ path: '../../artifacts/trash-actions-aligned.png', animations: 'disabled' });
});
