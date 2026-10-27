import { test, expect } from "@playwright/test";

test("management layout, accessible dialogs, subtitle shortcut and mobile navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/manage/");
  await expect(page.getByLabel("家庭 ID", { exact: true })).toHaveCount(0);
  await page.getByLabel("账号", { exact: true }).fill("parent@example.test");
  await page.getByLabel("密码", { exact: true }).fill("parent-e2e");
  const loginRequest = page.waitForRequest((request) =>
    request.url().endsWith("/api/manage/auth/login") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  expect((await loginRequest).postDataJSON()).toEqual({ username: "parent@example.test", password: "parent-e2e" });
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
  await expect(page.locator('.workspace-brandbar')).toHaveCount(0);
  await expect(page.locator('.manage-sidebar > .wordmark')).toBeVisible();
  await expect(page.locator('.manage-sidebar > .wordmark img')).toHaveAttribute('src', '/manage/brand/mollytime-icon.svg');
  await page.getByRole("navigation", { name: "管理导航" }).getByRole("link", { name: "资源库", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "英语启蒙", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../../artifacts/manage-redesign-library.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "英语启蒙", exact: true }).click();
  await page.getByRole("button", { name: "第 1 季", exact: true }).click();
  await page
    .getByRole("button", { name: "更多操作 Hello", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "上传字幕", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "上传文件 · Hello" }),
  ).toBeVisible();
  await expect(page.getByLabel("文件用途")).toHaveAttribute("data-value", "subtitle");
  await expect(
    page.getByText("UTF-8 编码的 SRT / VTT", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../../artifacts/manage-redesign-subtitles.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "上传文件 · Hello", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "第 1 季", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回英语启蒙", exact: true }).click();
  await page.getByRole("button", { name: "返回全部文件夹", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "我的电视" })
    .click();
  await expect(page.getByRole("heading", { name: "儿童档案", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "播放偏好", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /刷新/ })).toHaveCount(0);
  await page.screenshot({
    path: "../../artifacts/manage-redesign-settings.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "账号菜单" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../../artifacts/manage-redesign-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "账号菜单" }).click();
  await page.getByRole("menuitem", { name: "退出账号", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "进入管理后台" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
