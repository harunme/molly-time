import { expect, test } from "@playwright/test";

test("global Tailwind tokens update inputs, buttons and cards together", async ({ page }) => {
  await page.route('**/api/manage/uploads?*', route => route.fulfill({ json: { items: [], total: 1, page: 1, pageSize: 20 } }));
  await page.goto("/manage/");
  await expect(page.getByRole('button', { name: '登录', exact: true })).toHaveCSS('background-color', 'rgb(248, 222, 126)');
  await expect(page.getByRole('button', { name: '登录', exact: true })).toHaveCSS('color', 'rgb(63, 58, 50)');
  await page.getByLabel("账号", { exact: true }).fill("parent@example.test");
  await page.getByLabel("密码", { exact: true }).fill("parent-e2e");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation", { name: "管理导航" }).getByRole("link", { name: "资源库", exact: true }).click();
  await expect(page.getByRole('button', { name: '添加内容', exact: true })).toBeVisible();
  await expect(page.locator('.manage-sidebar .nav-link.active')).toHaveCSS('background-color', 'rgb(248, 222, 126)');
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    const theme = document.documentElement.style;
    theme.setProperty("--spacing-control", "3.25rem");
    theme.setProperty("--radius-ui", "1rem");
    theme.setProperty("--color-card", "rgb(240, 245, 250)");
  });
  const action = page.getByRole('button', { name: '上传任务', exact: true });
  await expect(action).toHaveCSS("height", "52px");
  await expect(action).toHaveCSS("background-color", "rgb(240, 245, 250)");
  expect(await action.evaluate((element) => parseFloat(getComputedStyle(element).borderTopLeftRadius) >= element.clientHeight / 2)).toBe(true);
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/manage/resources');
  await page.getByRole('button', { name: '添加内容', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建文件夹', exact: true }).click();
  const folder = await (await created).json();
  const input = page.getByRole('textbox', { name: '文件夹名称', exact: true });
  await expect(input).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(input).toHaveCSS('height', '30px');
  await page.keyboard.press("Escape");
  const session = await (await page.request.get('/api/manage/auth/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  await page.request.post(`/api/manage/resources/${folder.id}/archive`, { headers });
  await page.request.delete(`/api/manage/trash/${folder.id}`, { headers });
  await page.getByRole("navigation", { name: "管理导航" }).getByRole("link", { name: "家庭设置", exact: true }).click();
  await expect(page.locator('[data-slot="card"]').first()).toHaveCSS("background-color", "rgb(240, 245, 250)");
});

test("operations keep a visible black underline after the shared Tabs migration", async ({ page }) => {
  await page.goto("/manage/#/operations/storage");
  await page.getByLabel("账号", { exact: true }).fill("operator@example.test");
  await page.getByLabel("密码", { exact: true }).fill("operator-e2e");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const active = page.getByRole("tab", { name: "文件存储", exact: true });
  await expect(active).toHaveAttribute("aria-selected", "true");
  const underline = await active.evaluate((element) => {
    const style = getComputedStyle(element, "::after");
    return { position: style.position, height: style.height, width: parseFloat(style.width), color: style.backgroundColor, opacity: style.opacity };
  });
  expect(underline).toMatchObject({ position: "absolute", height: "3px", color: "rgb(0, 0, 0)", opacity: "1" });
  expect(underline.width).toBeGreaterThan(0);
});
