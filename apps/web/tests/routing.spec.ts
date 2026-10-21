import { test, expect, type Page } from "@playwright/test";

async function login(page: Page, account = "parent@example.test", password = "parent-e2e") {
  await page.getByLabel("账号", { exact: true }).fill(account);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("deep links survive login and refresh; navigation supports history and new tabs", async ({ page, context }) => {
  const errors: string[] = [];
  const documents: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documents.push(new URL(request.url()).pathname);
    }
  });
  await page.goto("/manage/#/library");
  await expect(page).toHaveURL(/\/manage\/#\/login$/);
  await page.reload();
  await login(page);
  await expect(page).toHaveURL(/\/manage\/#\/library$/);
  const navigation = page.getByRole("navigation", { name: "管理导航", exact: true });
  await expect(navigation.getByRole("link", { name: "资源库", exact: true })).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("link", { name: "家庭设置", exact: true }).click();
  await expect(page).toHaveURL(/\/manage\/#\/family\/general$/);
  await expect(page.getByRole("heading", { name: "家庭设置", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "资源库", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "家庭设置", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "家庭设置", exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto(new URL('/manage/#/upload', page.url()).href);
  await expect(other).toHaveURL(/\/manage\/#\/library\?uploads=1$/);
  await expect(other.getByRole("dialog", { name: "上传任务", exact: true })).toBeVisible();
  await other.close();
  expect(documents.every((path) => path === "/manage/")).toBe(true);
  expect(errors).toEqual([]);
});

test("old invitation tokens stay in the fragment, including same-document navigation", async ({ page }) => {
  const token = "a".repeat(64);
  await page.route("**/api/manage/auth/invitation/preview", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ token });
    expect(route.request().url()).not.toContain(token);
    await route.fulfill({ json: { email: "invited@example.test", familyName: "受邀家庭", expiresAt: "2099-01-01T00:00:00Z" } });
  });
  await page.goto("/manage/#/login");
  await expect(page.getByRole("heading", { name: "进入管理后台", exact: true })).toBeVisible();
  await page.goto(`/manage/#invite=${token}`);
  await expect(page).toHaveURL(new RegExp(`/manage/#/invite\\?token=${token}$`));
  await expect(page.getByLabel("设置密码", { exact: true })).toBeVisible();
  await expect(page.locator('input[type="email"]')).toHaveValue("invited@example.test");
  await page.reload();
  await expect(page.getByLabel("设置密码", { exact: true })).toBeVisible();
});

test("folder URLs restore the folder after refresh and browser back returns to the library", async ({ page }) => {
  await page.goto("/manage/#/library");
  await login(page);
  await page.getByRole("button", { name: "英语启蒙", exact: true }).click();
  await expect(page).toHaveURL(/\/manage\/#\/library\/series$/);
  await expect(page.getByRole("button", { name: "第 1 季", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "英语启蒙", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "第 1 季", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/manage\/#\/library$/);
  await expect(page.getByRole("heading", { name: "资源库", exact: true })).toBeVisible();
  await page.goto("/manage/#/library/missing-folder");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("link", { name: "全部文件夹", exact: true }).click();
  await expect(page.getByRole("heading", { name: "资源库", exact: true })).toBeVisible();
});

test("operations tabs are routable and maintain selection through refresh and history", async ({ page }) => {
  await page.goto("/manage/#/operations/invitations");
  await login(page, "operator@example.test", "operator-e2e");
  await expect(page).toHaveURL(/\/manage\/#\/operations\/invitations$/);
  await expect(page.getByRole("tabpanel", { name: "用户邀请", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "用户邀请", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(page.getByRole("tab", { name: "用户邀请", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "客户端版本", exact: true }).click();
  await expect(page).toHaveURL(/\/manage\/#\/operations\/client-releases$/);
  await page.goBack();
  await expect(page.getByRole("tab", { name: "用户邀请", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(page.getByRole("tab", { name: "客户端版本", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goto("/manage/#/operations");
  await expect(page).toHaveURL(/\/manage\/#\/operations\/storage$/);
  await expect(page.getByRole("combobox", { name: "存储方式", exact: true })).toBeVisible();
  await page.goto("/manage/#/operations/unknown");
  await expect(page).toHaveURL(/\/manage\/#\/operations\/storage$/);
});

test("ordinary users cannot enter operations through a URL; unknown routes return to overview", async ({ page }) => {
  await page.goto("/manage/#/operations/invitations");
  await login(page);
  await expect(page).toHaveURL(/\/manage\/#\/overview$/);
  await expect(page.getByRole("link", { name: "运营设置", exact: true })).toHaveCount(0);
  expect((await page.request.get("/api/manage/operations/invitations")).status()).toBe(403);
  await page.goto("/manage/#/not-a-page");
  await expect(page).toHaveURL(/\/manage\/#\/overview$/);
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
});

test("legacy invitation and pairing URLs remain usable and pairing opens over family settings", async ({ page }) => {
  await page.goto("/manage/#invite=");
  await expect(page).toHaveURL(/\/manage\/#\/invite$/);
  await expect(page.locator(".account-card")).toBeVisible();
  await page.reload();
  await expect(page.locator(".account-card")).toBeVisible();
  await page.getByRole("button", { name: "返回登录", exact: true }).click();
  await expect(page).toHaveURL(/\/manage\/#\/login$/);
  await page.goto("/manage/?pair=");
  await expect(page).toHaveURL(/\/manage\/#\/login$/);
  await login(page);
  await expect(page).toHaveURL(/\/manage\/#\/family\/devices\?pair=1&code=$/);
  await expect(page.getByRole("heading", { name: "绑定电视", exact: true })).toBeVisible();
  await expect(page.locator('.family-settings-tabs [data-slot="tabs-trigger"][data-state="active"]')).toHaveText("电视设备");
  const backgroundRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && ["/api/manage/settings", "/api/manage/devices"].includes(url.pathname)) {
      backgroundRequests.push(url.pathname);
    }
  });
  await page.getByRole("dialog", { name: "绑定电视", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
  await expect(page).toHaveURL(/\/manage\/#\/family\/devices$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(backgroundRequests).toEqual([]);
  await page.getByRole("button", { name: "绑定电视", exact: true }).click();
  await expect(page).toHaveURL(/\/manage\/#\/family\/devices\?pair=1$/);
  await expect(page.getByRole("dialog", { name: "绑定电视", exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "绑定电视", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page).toHaveURL(/\/manage\/#\/family\/devices$/);
  expect(backgroundRequests).toEqual([]);
  await page.getByRole("button", { name: "绑定电视", exact: true }).click();
  await expect(page.locator(".page-title h1")).toHaveText("家庭设置");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "家庭设置", exact: true })).toBeVisible();
  await page.route("**/api/manage/pairing/1234", (route) => route.fulfill({
    json: { name: "配对测试电视", expiresAt: "2099-01-01T00:00:00Z" },
  }));
  await page.goto("/manage/?pair=1234");
  await expect(page).toHaveURL(/\/manage\/#\/family\/devices\?pair=1&code=1234$/);
  await expect(page.locator(".pairing-summary")).toContainText("1234");
  await page.reload();
  await expect(page.locator(".pairing-summary")).toContainText("1234");
});
