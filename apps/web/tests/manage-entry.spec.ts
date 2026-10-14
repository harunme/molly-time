import { expect, test } from '@playwright/test';

test('management entry animation does not create temporary document overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    document.addEventListener('animationstart', (event) => {
      if (!(event.target instanceof HTMLElement) || !event.target.matches('.page-content')) return;
      for (const animation of event.target.getAnimations()) {
        animation.pause();
        animation.currentTime = 0;
      }
    });
  });
  await page.goto('/manage/#/trash');
  await page.getByLabel('账号', { exact: true }).fill('operator@example.test');
  await page.getByLabel('密码', { exact: true }).fill('operator-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '回收站', exact: true })).toBeVisible();
  const animation = await page.locator('.page-content').evaluate((element) => {
    const animations = element.getAnimations();
    const during = document.documentElement.scrollHeight;
    animations.forEach((animation) => animation.finish());
    return { count: animations.length, during, after: document.documentElement.scrollHeight, viewport: innerHeight };
  });
  expect(animation.count).toBeGreaterThan(0);
  expect(animation.after).toBe(animation.viewport);
  expect(animation.during).toBe(animation.after);

  // Long pages must still scroll normally.
  await page.locator('.page-content').evaluate((element) => { (element as HTMLElement).style.minHeight = '2000px'; });
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(1000);
  await page.evaluate(() => window.scrollTo(0, 300));
  expect(await page.evaluate(() => window.scrollY)).toBe(300);
});
