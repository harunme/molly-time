import { expect, test, type Page } from "@playwright/test";

test.use({ timezoneId: "America/Los_Angeles" });

async function openReports(page: Page) {
  await page.goto("/manage/");
  await page.getByLabel("账号", { exact: true }).fill("parent@example.test");
  await page.getByLabel("密码", { exact: true }).fill("parent-e2e");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation").getByRole("link", { name: "观看记录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "观看记录", exact: true })).toBeVisible();
}

async function navigateCalendar(page: Page, year: string, month: string) {
  const dialog = page.getByRole("dialog", { name: "选择日期", exact: true });
  await dialog.getByRole("combobox", { name: "选择年份", exact: true }).click();
  await page.getByRole("option", { name: year, exact: true }).click();
  await dialog.getByRole("combobox", { name: "选择月份", exact: true }).click();
  await page.getByRole("option", { name: month, exact: true }).click();
}

test("shared date picker submits calendar dates without UTC day shifts and preserves quick ranges", async ({ page }) => {
  await openReports(page);
  expect(await page.locator('input[type="date"]').count()).toBe(0);
  await page.getByRole("button", { name: "开始日期", exact: true }).click();
  await navigateCalendar(page, "2024", "二月");
  await page.getByTestId("watch-start-date-calendar-day-2024-02-29").click();
  await expect(page.getByRole("button", { name: "开始日期", exact: true })).toHaveText("2024/02/29");
  await page.getByRole("button", { name: "结束日期", exact: true }).click();
  await navigateCalendar(page, "2024", "三月");
  const response = page.waitForResponse((result) => {
    const url = new URL(result.url());
    return url.pathname.endsWith("/reports/watch-time") && url.searchParams.get("start") === "2024-02-29"
      && url.searchParams.get("end") === "2024-03-01" && result.ok();
  });
  await page.getByTestId("watch-end-date-calendar-day-2024-03-01").click();
  await response;
  await expect(page.getByRole("button", { name: "结束日期", exact: true })).toHaveText("2024/03/01");
  await page.getByRole("button", { name: "结束日期", exact: true }).click();
  await page.getByRole("button", { name: "前往下个月", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "选择月份", exact: true })).toContainText("四月");
  await page.getByRole("button", { name: "前往上个月", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "选择月份", exact: true })).toContainText("三月");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "结束日期", exact: true })).toBeFocused();
  const todayReport = page.waitForResponse((result) => {
    const url = new URL(result.url());
    return url.pathname.endsWith("/reports/watch-time") && url.searchParams.get("start") === url.searchParams.get("end") && result.ok();
  });
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await todayReport;
  await page.getByRole("button", { name: "近 7 天", exact: true }).click();
  await expect(page.getByRole("button", { name: "开始日期", exact: true })).not.toHaveText("2024/02/29");
});

test("date calendar and year dropdown fit mobile and support keyboard date selection", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReports(page);
  await page.getByRole("button", { name: "结束日期", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "选择日期", exact: true });
  await expect(dialog.getByRole("combobox", { name: "选择年份", exact: true })).toBeVisible();
  await page.screenshot({ path: "../../artifacts/watch-date-picker-mobile.png", fullPage: true, animations: "disabled" });
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const selected = dialog.locator('[data-selected="true"] button');
  await expect(selected).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
});
