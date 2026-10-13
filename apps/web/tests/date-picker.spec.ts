import { expect, test } from "@playwright/test";

test("watching details use chart selection without date query controls", async ({ page }) => {
  await page.goto("/manage/#/watch");
  await page.getByLabel("账号", { exact: true }).fill("parent@example.test");
  await page.getByLabel("密码", { exact: true }).fill("parent-e2e");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "观看记录", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await expect(dialog.locator('[data-slot="date-picker"]')).toHaveCount(0);
  await expect(dialog.locator('.watch-history-bars button')).toHaveCount(31);
  const lastDay = dialog.locator('.watch-history-bars button').last();
  const date = (await lastDay.getAttribute('aria-label'))!.slice(0, 10);
  await lastDay.focus();
  const request = page.waitForRequest(request => request.url().includes('/reports/watch-time?') && new URL(request.url()).searchParams.get('start') === date);
  await page.keyboard.press('Enter');
  await request;
  await expect(dialog.locator('.watch-history-detail').first()).toHaveAttribute('open', '');
  await dialog.getByRole('button', { name: '全部记录', exact: true }).click();
  await expect(dialog.locator('.watch-history-scope')).toHaveText('最近 31 天');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});
