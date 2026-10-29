import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1440, height: 1000 }, { width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`library and trash fill the available height at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/manage/#/library');
    await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
    await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    for (const [name, selector] of [['资源库', '.resource-library-card'], ['回收站', '.trash-list-card']]) {
      await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name, exact: true }).click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      await expect(page.getByText(/正在加载|正在打开…/)).toHaveCount(0);
      if (name === '回收站') await expect(page.locator('.trash-summary')).toBeVisible();
      const card = page.locator(selector);
      const footer = page.locator('.manage-footer');
      const bounds = (await card.boundingBox())!;
      const footerBounds = (await footer.boundingBox())!;
      expect(Math.abs(bounds.y + bounds.height - footerBounds.y)).toBeLessThanOrEqual(24);
      const navHeight = viewport.width < 1024 ? (await page.getByRole('navigation', { name: '管理导航' }).boundingBox())!.height : 0;
      expect(footerBounds.y + footerBounds.height).toBeGreaterThanOrEqual(viewport.height - navHeight - 17);
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(viewport.height + 1);
      if (name === '回收站') {
        expect(await card.locator('.trash-list-body').evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const pagination = (await card.locator('.pagination').boundingBox())!;
      expect(bounds.y + bounds.height - pagination.y - pagination.height).toBeLessThan(60);
      await page.screenshot({ path: `../../artifacts/list-height-${name}-${viewport.width}.png`, animations: 'disabled' });
    }
  });
}
