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
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table).toContainText("我们的家庭");
  await expect(table).toContainText("3 个账号");
  await chooseMonth(page, "2020", 1);
  await expect(table.locator("tbody tr td").nth(3)).toContainText("0 B");
  await expect(page.getByText("OSS 自动统计未启用", { exact: false })).toBeVisible();
  await expect(page.getByText("所选月份 OSS 日志公网下行", { exact: false })).toContainText("未归属家庭 0 B");
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
  await expect(page.getByRole("heading", { name: "导入 OSS 访问日志" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "../../artifacts/family-usage-mobile.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "../../artifacts/family-usage-desktop.png", fullPage: true, animations: "disabled" });
});

test("OSS reports show attributed bytes, unmatched traffic and synchronization failures", async ({ page }) => {
  const sync = { enabled: true, lastSuccessAt: "2026-10-30T01:00:00Z", lastAttemptAt: "2026-10-30T02:00:00Z", error: "OSS 日志同步失败，请检查日志格式、存储配置及读取权限" };
  await page.route("**/api/manage/operations/usage/oss?*", async (route) => {
    const month = new URL(route.request().url()).searchParams.get("month");
    await route.fulfill({ json: { month, publicBytes: 128 * 1024 ** 2, unattributedBytes: 24 * 1024 ** 2, sync } });
  });
  await page.route(/\/api\/manage\/usage(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const row = await response.json();
    row.traffic.ossBytes = 104 * 1024 ** 2;
    row.traffic.totalBytes = row.traffic.localBytes + row.traffic.ossBytes;
    row.ossSync = sync;
    await route.fulfill({ response, json: row });
  });
  await login(page, true);
  await page.getByRole("navigation").getByRole("link", { name: "家庭设置", exact: true }).click();
  await expect(page.getByText("OSS 公网下行 104.0 MB", { exact: false })).toBeVisible();
  await expect(page.getByText(sync.error, { exact: false })).toBeVisible();
  await page.getByRole("navigation").getByRole("link", { name: "运营设置", exact: true }).click();
  await page.getByRole("tab", { name: "家庭用量", exact: true }).click();
  const summary = page.getByText("所选月份 OSS 日志公网下行", { exact: false });
  await expect(summary).toContainText("128.0 MB");
  await expect(summary).toContainText("未归属家庭 24.0 MB");
  await expect(page.getByText(sync.error, { exact: false })).toBeVisible();
});
