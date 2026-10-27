import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.getByLabel("账号", { exact: true }).fill("parent@example.test");
  await page.getByLabel("密码", { exact: true }).fill("parent-e2e");
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("QR pairing survives login in a mobile modal and revoked TVs disappear", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const start = await page.request.post("/api/auth/pairing/start", { data: { name: "弹窗配对电视" } });
  expect(start.ok()).toBe(true);
  const { userCode, deviceCode } = await start.json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/manage/?pair=${userCode}`);
  await login(page);
  const dialog = page.getByRole("dialog", { name: "绑定电视", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".page-title h1")).toHaveText("我的电视");
  await expect(dialog.locator(".pairing-summary")).toContainText(userCode);
  await expect(dialog.getByLabel("电视名称")).toHaveValue("弹窗配对电视");
  const pending = await page.request.post("/api/auth/pairing/poll", { data: { deviceCode } });
  expect(pending.status()).toBe(200);
  expect((await pending.json()).status).toBe("pending");
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(358);
  expect(bounds!.x).toBeGreaterThanOrEqual(16);
  await page.screenshot({ path: "../../artifacts/parent-pairing-modal-mobile.png" });
  await dialog.getByLabel("电视名称").fill("弹窗绑定的电视");
  await dialog.getByRole("button", { name: "确认绑定这台电视", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "已确认绑定", exact: true })).toBeVisible();
  let auth: { accessToken: string };
  await expect.poll(async () => {
    const response = await page.request.post("/api/auth/pairing/poll", { data: { deviceCode } });
    const result = await response.json();
    if (result.status === "authorized") auth = result.auth;
    return result.status;
  }, { intervals: [3000], timeout: 15000 }).toBe("authorized");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page).toHaveURL(/#\/devices$/);
  const row = page.locator(".watch-control-device").filter({ hasText: "弹窗绑定的电视" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /的更多操作$/ }).click();
  await page.getByRole("menuitem", { name: "取消配对", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText("已取消配对", { exact: true })).toHaveCount(0);
  expect((await page.request.get("/api/home", { headers: { Authorization: `Bearer ${auth!.accessToken}` } })).status()).toBe(401);
  await page.reload();
  await expect(row).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("manual pairing has normal modal dismissal, focus, history and local errors", async ({ page }) => {
  await page.goto("/manage/#/family/devices");
  await login(page);
  const trigger = page.getByRole("button", { name: "绑定电视", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "绑定电视", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("电视配对码")).toBeFocused();
  await expect(dialog.getByRole("button", { name: "查看电视" })).toBeDisabled();
  await page.route("**/api/manage/pairing/0000", (route) => route.fulfill({ status: 404, json: { detail: "配对码已过期，请查看电视上的新配对码" } }));
  await dialog.getByLabel("电视配对码").fill("0000");
  await dialog.getByRole("button", { name: "查看电视" }).click();
  await expect(dialog.getByRole("alert")).toContainText("配对码已过期");
  await page.screenshot({ path: "../../artifacts/parent-pairing-modal-desktop.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.goForward();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("电视配对码")).toHaveValue("");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await trigger.click();
  await page.goBack();
  await expect(dialog).toHaveCount(0);
});

test("active TV pagination returns to the previous page after revoking its last device", async ({ page }) => {
  let revoked = false;
  await page.route("**/api/manage/devices?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("activeOnly")).toBe("true");
    const current = Number(params.get("page"));
    const total = revoked ? 20 : 21;
    const all = Array.from({ length: total }, (_, index) => ({ id: `tv-${index}`, name: `电视 ${index + 1}`, lastSeen: null, revoked: false }));
    await route.fulfill({ json: { items: all.slice((current - 1) * 20, current * 20), total, page: current, pageSize: 20 } });
  });
  await page.route("**/api/manage/devices/tv-20/revoke", async (route) => {
    revoked = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/manage/#/family/devices");
  await login(page);
  const pagination = page.getByRole("navigation", { name: "设备分页", exact: true });
  await expect(pagination).toContainText("共 21 条");
  await pagination.getByRole("button", { name: "设备分页：下一页" }).click();
  const row = page.locator(".watch-control-device").filter({ hasText: "电视 21" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /的更多操作$/ }).click();
  await page.getByRole("menuitem", { name: "取消配对", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(pagination).toHaveCount(0);
  await expect(page.locator(".watch-device-count")).toHaveText("20 台");
  await expect(page.locator(".watch-control-device")).toHaveCount(20);
});
