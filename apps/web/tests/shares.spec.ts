import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, user: string) {
  await page.getByLabel("账号", { exact: true }).fill(`${user}@example.test`);
  await page.getByLabel("密码", { exact: true }).fill(`${user}-e2e`);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("share collection, login through link, receive draft and publish independently", async ({ page, browser }) => {
  await page.goto("/manage/");
  await login(page, "parent");
  await page.getByRole("navigation", { name: "管理导航" }).getByRole("link", { name: "资源库", exact: true }).click();
  await page.getByRole("button", { name: "更多操作 英语启蒙" }).click();
  await page.getByRole("menuitem", { name: "分享内容" }).click();
  const dialog = page.getByRole("dialog", { name: "分享 · 英语启蒙" });
  await expect(dialog.getByText(/3 个视频/)).toBeVisible();
  await dialog.getByRole("button", { name: "生成分享", exact: true }).click();
  const url = await dialog.getByLabel("分享链接").inputValue();
  await expect(dialog.getByLabel("分享口令")).toHaveValue(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await page.screenshot({ path: test.info().outputPath("share-dialog.png") });

  const context = await browser.newContext();
  try {
    const receiving = await context.newPage();
    await receiving.goto(url);
    await login(receiving, "receiver");
    await expect(receiving.getByRole("heading", { name: "领取分享" })).toBeVisible();
    await expect(receiving.getByRole("heading", { name: "英语启蒙", exact: true })).toBeVisible();
    await expect(receiving.getByRole("button", { name: "加入我的内容库" })).toBeEnabled();
    await receiving.setViewportSize({ width: 390, height: 844 });
    await receiving.screenshot({ path: test.info().outputPath("share-receive-mobile.png") });
    expect(await receiving.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await receiving.getByRole("button", { name: "加入我的内容库" }).click();
    await expect(receiving.getByRole("heading", { name: "英语启蒙", exact: true })).toBeVisible();
    await expect(receiving.getByRole("button", { name: "Hello", exact: true })).toBeVisible();
    await expect(receiving.getByRole("button", { name: "发布", exact: true })).toHaveCount(3);
    await receiving.goto(url);
    await expect(receiving.getByText("你的家庭已领取此分享，无需重复加入。")).toBeVisible();
    await receiving.getByRole("link", { name: "查看我的内容" }).click();
    await expect(receiving.getByRole("button", { name: "Hello", exact: true })).toBeVisible();
    // Publish the collection and its episodes using the same authenticated APIs as the UI.
    const published = await receiving.evaluate(async () => {
      const session = await (await fetch("/api/manage/auth/session")).json();
      const folders = await (await fetch("/api/manage/resources")).json();
      const folder = folders.find((item: { name: string }) => item.name === "英语启蒙");
      const episodes = await (await fetch(`/api/manage/folders/${folder.id}/videos`)).json();
      const headers = { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken };
      for (const id of [folder.id, ...episodes.map((ep: { id: string }) => ep.id)]) {
        const response = await fetch(`/api/manage/resources/${id}/publish`, { method: "POST", headers });
        if (!response.ok) return false;
      }
      return true;
    });
    expect(published).toBe(true);
    await receiving.reload();
    await receiving.getByRole("button", { name: "更多操作 Hello" }).click();
    await expect(receiving.getByRole("menuitem", { name: "分享内容" })).toHaveCount(0);
    await receiving.getByRole("menuitem", { name: "预览视频" }).click();
    await expect(receiving.getByRole("dialog", { name: "家长预览 · Hello" }).locator("video")).toHaveAttribute("src", /mediaId=/);
  } finally { await context.close(); }
});

test("single video is received via code into a chosen collection", async ({ page, browser }) => {
  await page.goto("/manage/");
  await login(page, "parent");
  await page.getByRole("navigation", { name: "管理导航" }).getByRole("link", { name: "资源库", exact: true }).click();
  await page.getByRole("button", { name: "英语启蒙", exact: true }).click();
  await page.getByRole("button", { name: "更多操作 Hello" }).click();
  await page.getByRole("menuitem", { name: "分享内容" }).click();
  const dialog = page.getByRole("dialog", { name: "分享 · Hello" });
  await dialog.getByRole("button", { name: "生成分享", exact: true }).click();
  const code = await dialog.getByLabel("分享口令").inputValue();
  const context = await browser.newContext();
  try {
    const receiving = await context.newPage();
    await receiving.goto("/manage/#/share");
    await login(receiving, "receiver");
    await receiving.getByLabel("分享链接或口令").fill(code);
    await receiving.getByRole("button", { name: "查看分享", exact: true }).click();
    await expect(receiving.getByRole("button", { name: "加入我的内容库" })).toBeDisabled();
    await receiving.getByRole("combobox", { name: "接收合集" }).click();
    await receiving.getByRole("option", { name: "我的收藏", exact: true }).click();
    await receiving.getByRole("button", { name: "加入我的内容库" }).click();
    await expect(receiving.getByRole("heading", { name: "我的收藏", exact: true })).toBeVisible();
    await expect(receiving.getByRole("button", { name: "Hello", exact: true })).toBeVisible();
  } finally { await context.close(); }
});
