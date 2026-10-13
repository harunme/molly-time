import { test, expect } from "@playwright/test";

test("family administrator can rename the family and see it after reload", async ({ page }) => {
  await page.goto("/manage/#/family");
  await page.getByLabel("账号", { exact: true }).fill("parent@example.test");
  await page.getByLabel("密码", { exact: true }).fill("parent-e2e");
  await page.getByRole("button", { name: "登录", exact: true }).click();

  const name = page.getByLabel("家庭名称", { exact: true });
  const original = await name.inputValue();
  await name.fill("  周末放映室  ");
  await page.getByRole("button", { name: "保存家庭名称" }).click();
  await expect(name).toHaveValue("周末放映室");
  await page.getByRole("navigation", { name: "管理导航" }).getByRole("link", { name: "概览" }).click();
  await expect(page.getByText("周末放映室的设备在线状态与观看习惯。")).toBeVisible();
  await page.reload();
  await expect(page.getByText("周末放映室的设备在线状态与观看习惯。")).toBeVisible();

  await page.getByRole("navigation", { name: "管理导航" }).getByRole("link", { name: "家庭设置" }).click();
  await name.fill(original);
  await page.getByRole("button", { name: "保存家庭名称" }).click();
  await expect(name).toHaveValue(original);
});
