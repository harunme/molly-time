import { expect, test } from '@playwright/test';

test('online count, unit and surrounding text share the same size and vertical center', async ({ page }) => {
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const online = page.locator('.overview-online');
  await expect(online.locator('.overview-metric-value')).toHaveText('0 台');
  for (const width of [1280, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    const label = online.locator('.overview-metric-label > span');
    const value = online.locator('.overview-metric-value');
    const unit = online.locator('.overview-metric-unit').filter({ hasText: '台' });
    const detail = online.locator('.overview-metric-bottom > span');
    const font = await label.evaluate(el => getComputedStyle(el).fontSize);
    await expect(value).toHaveCSS('font-size', font);
    await expect(unit).toHaveCSS('font-size', font);
    const boxes = await Promise.all([label, value, unit, detail].map(item => item.boundingBox()));
    const centers = boxes.map(box => box!.y + box!.height / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1);
    await online.screenshot({ path: `../../artifacts/online-device-aligned-${width}.png`, animations: 'disabled' });
  }
});
