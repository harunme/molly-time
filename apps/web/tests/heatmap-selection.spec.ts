import { expect, test } from '@playwright/test';

test('selected dates breathe without changing heat intensity and respect reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/manage/');
  await page.getByLabel('账号', { exact: true }).fill('parent@example.test');
  await page.getByLabel('密码', { exact: true }).fill('parent-e2e');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const selected = page.locator('.overview-heatmap-day[aria-pressed="true"]');
  await expect(selected).toHaveCount(1);
  const appearance = () => selected.evaluate(el => ({
    animation: getComputedStyle(el, '::after').animationName,
    duration: getComputedStyle(el, '::after').animationDuration,
    fill: getComputedStyle(el).backgroundColor,
    width: el.getBoundingClientRect().width,
  }));
  await expect.poll(async () => (await appearance()).animation).toBe('heatmap-selected-breathe');
  const before = await appearance();
  expect(before.duration).toBe('2.4s');
  await selected.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(selected).toHaveCount(1);
  await expect(page.locator('.overview-heatmap-day[aria-pressed="false"]')).toHaveCount(364);
  const beforeReducedMotion = await appearance();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(async () => (await appearance()).animation).toBe('none');
  const after = await appearance();
  expect(after.width).toBe(before.width);
  expect(after.fill).toBe(beforeReducedMotion.fill);
});
