import { expect, test } from "@playwright/test";

test("global Tailwind tokens update inputs, buttons, select fields and cards together", async ({ page }) => {
  await page.goto("/manage/");
  await page.getByLabel("账号", { exact: true }).fill("parent@example.test");
  await page.getByLabel("密码", { exact: true }).fill("parent-e2e");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("navigation", { name: "管理导航" }).getByRole("link", { name: "资源库", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "搜索资源", exact: true })).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    const theme = document.documentElement.style;
    theme.setProperty("--spacing-control", "3.25rem");
    theme.setProperty("--radius-ui", "1rem");
    theme.setProperty("--color-card", "rgb(240, 245, 250)");
  });
  const search = page.locator('[data-slot="input-group"]').first();
  const filter = page.getByRole("combobox", { name: "资源状态" });
  const action = page.getByRole("button", { name: "新建动画片", exact: true });
  for (const control of [search, filter, action]) {
    await expect(control).toHaveCSS("height", "52px");
    await expect(control).toHaveCSS("background-color", "rgb(240, 245, 250)");
  }
  await expect(search).toHaveCSS("border-radius", "16px");
  for (const control of [filter, action]) {
    expect(await control.evaluate((element) => parseFloat(getComputedStyle(element).borderTopLeftRadius) >= element.clientHeight / 2)).toBe(true);
  }
  await action.click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("textbox", { name: "名称", exact: true });
  await expect(input).toHaveCSS("height", "52px");
  await expect(input).toHaveCSS("border-radius", "16px");
  await page.keyboard.press("Escape");
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
