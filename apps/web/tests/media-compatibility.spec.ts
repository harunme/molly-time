import { expect, test } from "@playwright/test";

test("preview distinguishes codec failures from network failures", async ({ page }) => {
  await page.goto("/manage/");
  await page.getByLabel("账号", { exact: true }).fill("parent@example.test");
  await page.getByLabel("密码", { exact: true }).fill("parent-e2e");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "概览", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "管理导航" })
    .getByRole("link", { name: "资源库", exact: true }).click();
  await page.getByRole("button", { name: "英语启蒙", exact: true }).click();
  await page.getByRole("button", { name: "Hello", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "家长预览 · Hello" });
  const video = preview.locator("video");
  await expect(video).toHaveAttribute("src", /mediaId=/);

  // Browser/platform codec availability varies; exercise standard MediaError codes.
  for (const code of [3, 4, 2]) {
    await video.evaluate((element, errorCode) => {
      Object.defineProperty(element, "error", { configurable: true, value: { code: errorCode } });
      element.dispatchEvent(new Event("error"));
    }, code);
    const message = code === 2
      ? "播放地址可能已过期或网络异常，请重试播放"
      : "浏览器无法解码或不支持此视频，请在电视客户端尝试播放";
    await expect(preview.getByText(message, { exact: false })).toBeVisible();
  }
});
