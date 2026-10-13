import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, operator = false) {
  await page.goto("/manage/");
  await page.getByLabel("账号", { exact: true }).fill(operator ? "operator@example.test" : "parent@example.test");
  await page.getByLabel("密码", { exact: true }).fill(operator ? "operator-e2e" : "parent-e2e");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
}

async function chooseMonth(page: Page, year: string, month: number) {
  await page.getByRole("button", { name: "用量月份", exact: true }).click();
  await page.getByRole("dialog", { name: "选择月份" }).getByRole("combobox", { name: "选择年份", exact: true }).click();
  await page.getByRole("option", { name: `${year}年`, exact: true }).click();
  await page.getByRole("button", { name: `${year}年${month}月`, exact: true }).click();
  await expect(page.getByRole("button", { name: "用量月份", exact: true })).toHaveText(`${year}年${month}月`);
}

test("family sees combined current storage and counted range bytes without operations access", async ({ page }) => {
  await login(page);
  const delivered = await page.request.get("/api/episodes/episode/play", { headers: { Range: "bytes=0-99" } });
  expect(delivered.status()).toBe(206);
  await page.getByRole("navigation").getByRole("link", { name: "家庭设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "家庭用量", exact: true })).toBeVisible();
  await expect(page.getByText("本月已统计流量")).toBeVisible();
  const report = await (await page.request.get("/api/manage/usage")).json();
  expect(report.accountCount).toBe(3);
  expect(report.traffic.localBytes).toBeGreaterThanOrEqual(100);
  expect(report.storage.usedBytes).toBeGreaterThan(0);
  expect((await page.request.get("/api/manage/operations/usage")).status()).toBe(403);
  await chooseMonth(page, "2020", 1);
  await expect(page.getByText("本月已统计流量")).toContainText("0 B");
});

test("operator filters usage, exports exact bytes and opens the route directly on mobile", async ({ page }) => {
  await login(page, true);
  await page.getByRole("navigation").getByRole("link", { name: "运营设置", exact: true }).click();
  await page.getByRole("tab", { name: "家庭用量", exact: true }).click();
  const table = page.locator(".family-usage-table");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("我们的家庭");
  await expect(table).toContainText("3 个账号");
  await chooseMonth(page, "2020", 1);
  await expect(table.locator("tbody tr td").nth(3)).toContainText("0 B");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "导出月度 CSV", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("family-usage-2020-01.csv");
  await page.getByLabel("搜索家庭或账号", { exact: true }).fill("missing-family");
  await expect(page.getByText("没有匹配的家庭。")).toBeVisible();
  await page.getByLabel("搜索家庭或账号", { exact: true }).fill("operator@example.test");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("tab", { name: "家庭用量", exact: true })).toHaveAttribute("data-state", "active");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "用量月份", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择月份" });
  await expect(picker.getByRole("button", { name: "本月", exact: true })).toBeVisible();
  await page.screenshot({ path: "../../artifacts/family-usage-month-picker-mobile.png", fullPage: true, animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole("button", { name: "用量月份", exact: true })).toBeFocused();
  await expect(page.getByLabel("OSS 访问日志", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "../../artifacts/family-usage-mobile.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "../../artifacts/family-usage-desktop.png", fullPage: true, animations: "disabled" });
});

test("OSS import reports deduplication and unresolved owners, and recovers from an invalid log", async ({ page }) => {
  let valid = false;
  await page.route("**/api/manage/operations/usage/oss-logs", (route) => route.fulfill({
    status: valid ? 200 : 422, contentType: "application/json",
    body: JSON.stringify(valid ? { imported: 2, duplicates: 1, ignored: 3, unresolved: 1 } : { detail: "第 1 行日志格式无效" }),
  }));
  await login(page, true);
  await page.goto("/manage/#/operations/usage");
  await page.getByLabel("OSS 访问日志", { exact: true }).setInputFiles({ name: "invalid.log", mimeType: "text/plain", buffer: Buffer.from("invalid") });
  await expect(page.getByRole("alert")).toContainText("第 1 行日志格式无效");
  valid = true;
  await page.getByLabel("OSS 访问日志", { exact: true }).setInputFiles({ name: "access.log", mimeType: "text/plain", buffer: Buffer.from("log fixture") });
  await expect(page.getByText("已导入 2 条，重复 1 条，忽略 3 条，未识别家庭 1 条。")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
